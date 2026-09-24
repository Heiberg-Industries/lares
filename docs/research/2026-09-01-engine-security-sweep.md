# Engine security & quality sweep — first pass (ORB-198)

**Date:** 2026-09-01 (autonomous day). **Scope:** the surfaces that become the Lares engine —
`packages/*`, `services/eve-*`, `services/console`, `services/readability`,
`services/signal-spine` — plus the dependency graph fleet-wide. **Depth:** the automatable layers
in full; the two judgment layers (injection posture, egress completeness) as posture statements
with named follow-ups. This is the *first* pass the circle-facing sweep builds on, not the final
word — source-available means outside eyes read everything, and this document is written to be
readable by them.

## Layer 1 — dependencies (`pnpm audit --prod`, 2026-09-01)

**158 findings: 1 critical, 62 high, 82 moderate, 13 low — and the distribution is the finding.**

| Cluster | Where | Disposition |
| --- | --- | --- |
| **The critical (`tar`) + the largest high-cluster** (form-data, nodemailer, axios, linkify-it, ip-address, deepmerge-ts…) | **`services/agent-runtime` — the RETIRED runtime** | Not engine code. Its only live consumers are notion-sync/atlas-sync — **ORB-178 (the rehome) is now security-motivated, not just hygiene.** Commented there. |
| Second cluster (next, undici, js-yaml, sharp, postcss, image-size, nanoid, immutable, fast-uri) | `services/cms` | Already ticketed: **ORB-26** (Next 15→16 carries most of it). |
| `@opentelemetry/*` highs | `services/eve-calliope`, `services/crm-intelligence` | Engine-relevant (calliope). Small bump, follow-up below. |
| `hono` | `services/consent`, `services/crm-intelligence` | ops services, not engine; patched versions exist — follow-up below. |
| `brace-expansion` | `packages/agent-kit` + others | transitive, low-risk pattern (ReDoS); rides normal updates. |
| `undici` in `services/atlas` | atlas-sync | rides ORB-178's rehome. |

**Engine surfaces (eve-* + packages) are comparatively clean** — the debt concentrates in the two
codebases already scheduled for retirement or migration.

## Layer 2 — hardcoded credentials

Pattern sweep (Slack `xox*`, `sk-*`, `ghp_*`, AWS `AKIA*`, PEM blocks) across all engine
surfaces: **zero hits.** The `keychain:`/secret-file discipline holds in code.

## Layer 3 — secrets in logs

Sweep for `console.*` calls interpolating token/secret/key/password variables (excluding the
legitimate "X is not set" class): **zero suspicious hits** on engine surfaces. The house pattern —
log the *name* of the missing secret, never a value — holds.

## Layer 4 — the ungated-write class (ORB-144's standing finding)

Spot-audit: every non-disabled tool file per agent classified for side-effect shape
(POST/PATCH/DELETE, SQL writes, sends), cross-checked against `agent.json` scopes.

- **No live instance found.** Saga's write-shaped tools (`gmail_send`, `calendar_delete_event`,
  `meeting_followup_send`) all sit under `write-with-confirm` capabilities. Marcel's three flags
  (`info`, `predeparture_pack`, `strava_routes`) dissolve on inspection — Telegram channel sends
  (the agent's own conversational output), not external mutations.
- **The structural gap remains exactly as ORB-144 stated it: nothing would CATCH a mismatch.**
  A future tool that mutates a third party under a `read` grant ships silently. The fix shape is
  a build-time lint in the same family as the ORB-152 drift alarm — write-shaped call patterns in
  a tool require a write-scoped grant, or the build fails. Follow-up below; the contributed-adapter
  checklist should require it once it exists.

## Layer 5 — prompt-injection posture (statement, not audit)

The engine's exposure: every tool that renders third-party content into a model turn —
`read_url` (readability output), Gmail bodies (triage, obligations), Slack messages (the scan),
Notion transcripts (follow-ups), Karakeep pages (digest enrich). Current posture relies on:
labeled context blocks (`labeledContext`), the store-answers-from-store-calls discipline,
approval gates in front of every consequential action, and sealed egress bounding what a hijacked
turn could reach. **What does not exist: any systematic injection test suite.** For a
source-available product this is the sweep's largest open half — follow-up below.

## Layer 6 — egress completeness (statement)

Sealed egress is enforced by the box (nft + squid allowlists), and the enforcement direction is
sound: an undeclared host fails closed (memory: "blocked calls look like *not found*" — which is
its own legibility follow-up, already known). Not re-audited host-by-host today; the
contributed-adapter checklist already requires documented egress per adapter.

## Verdict

**No live vulnerability found in engine code; the dependency debt concentrates precisely in the
two codebases already scheduled to die (agent-runtime via ORB-178, cms via ORB-26).** The two
structural gaps — no write-shape lint, no injection test suite — are the real pre-circle work,
and both fit the drift-alarm pattern this fleet already trusts.

## Follow-ups filed

- ORB-178: audit evidence added — the rehome now carries the fleet's only critical.
- New: dependency-hygiene batch (otel bumps for calliope, hono for consent/crm-intelligence).
- New: the write-shape lint (layer 4's structural fix).
- New: the injection test suite (layer 5).
