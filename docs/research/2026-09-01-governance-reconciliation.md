# Governance reconciliation — what survived the eve migration (ORB-191)

**Date:** 2026-09-01
**Why:** the masterplan's governance layer — capability registry, trust ratchet, never-list,
audit — was designed for the old runtime and "wraps every agent". The fleet then changed runtimes
underneath it and nobody wrote down which parts still hold. This note is that reconciliation.
Verified against the code and the live box, not the old specs.

## The table

| Governance piece | Old runtime | On eve today | Verdict |
| --- | --- | --- | --- |
| **Capability registry** | `agent.json` grants + `buildAgentHands` | `agent.json` `grants: [{capability, scope}]`, tools resolved at BUILD time (ORB-144); read any agent's real list from `.output/.eve/compile/` | **SURVIVED, improved** — declarative, and the build artifact is inspectable |
| **Approval gates (👍)** | confirm engine + Slack cards | eve's native approval flow (`approval: always()` + `assertApprover` + per-channel allowlists in `lib/principals.ts`) | **SURVIVED, replaced by eve's** — proven live repeatedly (ORB-167's refusal proof is the model) |
| **Trust ratchet — the data** | `ratchet` table in `lares_state` | table exists, rows stale; eve autonomy lives in `agent.json`'s `autonomy` key per agent | **DEAD as a table, ALIVE as config** — the dial moved from a DB row to a code-reviewed file |
| **Trust ratchet — the DIAL** | planned "ratchet board" console panel | never built; changing autonomy is an `agent.json` edit + image rebuild + repin + deploy | **THE GAP.** The Calliope re-gating finding stands: "re-gating is NOT a one-line autonomy edit" |
| **Never-list** | governance module checks | `disableTool()` files per agent — and **eve does not validate the filenames at build time** while 17 files across the fleet assume it does (ORB-152, open) | **AT RISK** — the mechanism exists, its enforcement is unverified |
| **Audit trail** | `audit` table | table exists in `lares_state`; eve writes its own session/workflow records; Langfuse traces every model call (project `lares-agents`) | **SPLIT** — old table dormant, real auditability lives in eve's stores + Langfuse |
| **Sealed egress** | nft saddr set + squid by domain | unchanged, and now load-bearing for Lares ("controlled egress by design" is a product claim) | **SURVIVED, promoted** |
| **Identity / principals** | identity registry (`users`/`user_aliases`) | same tables, plus per-channel allowlists at two enforcement points sharing one module | **SURVIVED** — and it is the multi-user substrate |

## What this means, in three sentences

The *checks* survived the migration better than the *dials*: every gate that stops an agent doing
something still exists and is enforced, but the mechanisms for **changing** what an agent may do
(the ratchet board) and for **proving** what an agent may never do (build-time never-list
validation) are respectively unbuilt and unverified. Autonomy changes being code edits is
acceptable for a solo operator and unacceptable for Lares, where the admin UI's whole promise is
that an owner turns dials without touching code. The two stale tables (`ratchet`, `audit`) should
be either re-adopted or dropped when the ratchet board is built — a table that looks
authoritative and is not is this fleet's most reliable source of future confusion.

## Actions (already ticketed, listed for the map)

- **ORB-152** — verify/force `disableTool()` filename validation (the never-list's enforcement).
- **Ratchet board** — folded into Lares sub-project 4 (admin UI) explicitly; the `autonomy` key
  in `agent.json` is the value it edits, and a UI edit must produce the same reviewed-change
  trail a code edit does today (the gate moves, the discipline must not).
- **`ratchet`/`audit` tables** — decide re-adopt or drop during the ratchet-board build; until
  then they are dormant, and nothing should be written to them as if they were live.
