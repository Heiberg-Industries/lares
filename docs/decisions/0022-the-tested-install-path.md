# ADR 0022 — One tested install path, web chat first, and no promised support

**Date:** 2026-09-18
**Status:** Accepted
**Supersedes:** —
**Amends:** `docs/specs/2026-09-14-lares-installer-and-wizard-design.md` — see "What changes" and
"What stays" below.

## In plain language

1. At launch there is exactly one installation path that has actually been tried and proven: a
   fresh Ubuntu server, one command.
2. The very first screen of setup offers "start fresh" or "restore from a backup" — restoring is
   not buried near the end.
3. Before the wizard asks much else, it checks the model key actually works by sending it a real
   test message, not just checking that it looks well-formed.
4. The wizard is shorter than originally planned — fewer questions stand between the owner and a
   working conversation.
5. Chatting with the agent through the console's web chat — not Slack, not Telegram — becomes the
   very first way an owner talks to their agent; connecting a chat app comes after.
6. Running Lares on a Mac is "best-effort": expected to work, with known differences written
   down, but it is not the rehearsed, proven path.
7. There is no promise of support. Help is a community chat channel with an agent answering, and
   the owner will occasionally join in personally; realistic expectations are low numbers.
8. Everywhere the documentation used to say "supported", it now says "tested path" — the honest
   word for what has actually been proven.

## Context

**The spec this amends, as it stands today.** `docs/specs/2026-09-14-lares-installer-and-wizard-design.md`
Part 4 lays out a **ten-step wizard**: sign-in, models, "your house", knowledge, connect Google,
first agent, doors (Slack/Telegram), backup, watchers, done (lines 169-180). The model key is
already tested with "one real call per provider through the gateway" at step 2 — that part of the
ruling is already the design, not a change. Doors (Slack/Telegram) are step 7, and the first
conversation the wizard proves is a reply inside whichever door the owner just claimed
(`docs/specs/…:177`) — there is no web-chat step at all in the ten-step table. Restore is not on
the first screen: it is a separate flag on the install command itself
(`… | bash -s -- --restore`, Part 2) and, inside the wizard, backup only appears at **step 8**,
near the end. Part 9's non-goals list states plainly that "the web chat door (ORB-270)" is
something that "will need to come fast after this phase" but is explicitly deferred, not built
now (`docs/specs/…:301-304`). Mac support is described only as a later phase with "known
differences recorded here so it is not re-discovered" (Part 1) — the spec does not use the words
"best-effort" anywhere.

**The installed eve already ships the web-chat building blocks.** Checked on 2026-09-18 against
the installed, pinned package (`node_modules/.pnpm/eve@0.32.0…/node_modules/eve/package.json`):
its `exports` map includes `./next`, `./react` and `./client` (alongside `./vue`, `./svelte`,
`./sveltekit` and `./nuxt`). Research report `05` describes the same surface upstream, grown into
a Web Chat channel (`eve add channel/web`, a generated Next.js app with session URLs and resume on
reload; an optional "Sign in with Vercel" variant, which Lares skips). The shapes of those exports
must be re-read against whatever eve version Lares is pinned to when the console work starts (see
ADR-0021) — the 0.32 → 0.60 upgrade sits between today and that work.

**The console does not use any eve chat client today.** A search of `services/console` for
`useEveAgent` and `eve/client` returns no matches — there is nothing to migrate or build on;
this would be new console surface.

**Every role's `agent/channels/eve.ts` already exists and gates eve's own HTTP session route.**
`services/chief-of-staff/agent/channels/eve.ts` wires `eveChannel` with HTTP Basic auth read from
a box secret file (`routePassword()`, lines 27-40) against `eve`'s built-in session routes; the
same file, with only the username/secret-file literals changed — the chief-of-staff role's copy
carries its own (persona-derived) username and secret-file name where the other two roles use the
plain `eve` / `eve-route-password` — exists at
`services/travel/agent/channels/eve.ts` and `services/creative/agent/channels/eve.ts` — confirmed
identical apart from those literals by direct diff. This is the route a web-chat client would call
through; it already exists and is already password-protected per role, but nothing in the console
speaks to it yet.

**Spend-cap defaults, and LAR-53.** The installer spec's current defaults are "$5/day per agent
key, $2/day per background-job key, $10/day installation ceiling; alerts at 85% and 95%" (spec
line 51). LAR-53's own text (a Linear ticket) is not present in this repo; what **is** present is
its implementation — `CHANGELOG.md:6` ("The travel agent now says plainly when its spend cap is
hit instead of failing with a generic error") and `services/travel/agent/channels/telegram.ts`
plus `services/travel/tests/telegram-budget-refusal.test.ts`, which change how a cap-exceeded
refusal is *reported*, not the cap numbers themselves. Nothing found in this worktree changes the
default figures above — **see LAR-53** for whether the owner's later decisions moved them; this
ADR keeps the installer spec's numbers as still current pending that check.

## Decision

### Installer boundary clarified — owner ruling, 2026-09-24

Web chat remains the first door, but the installer must not claim that a conversation exists before
an agent exists. The neutral-stack installer configures the keeper and the first agent's binding;
it does not create/reconcile the agent definition or runtime, and it does not yet mint/register the
agent's LiteLLM virtual key. Its final address is therefore the console's first-agent setup page,
not `/chat`, and its final text says that no agent runtime or conversation is ready yet.

This is an honesty boundary, not a reversal of web-chat-first. The installer may be complete while
the tested path is not: **first-agent creation, gateway-key provisioning, agent health and one real
web-chat turn must still be built and proved before Lares claims the tested path reaches a working
conversation.** Slack and Telegram remain after that first web-chat turn.

### Fresh-install creation prerequisites — owner ruling, 2026-09-24

After migrations, the installer initializes two settings only when they are absent:
`models.alias_prefix` is `lares` (the prefix of the shipped `lares-brain` alias), and
`agents.ceiling` is 1. The latter is the conservative capacity of the fresh tested path after its
6 GiB memory preflight, not a general capacity measurement. A repair run preserves existing
values, including an explicit zero lockout or a separately approved higher ceiling. This closes
the console's deliberate fail-closed state without making a hidden host override.

The installer also cannot guess the name or role chosen on `/agents/new`. Fresh keeper configs
therefore bind the real owner and the shared route-password source by role, with an exact per-name
binding taking precedence on existing installations. Keeper-created runtime, door and per-agent
key files live under its writable root; the installer-owned database and route-password files stay
read-only inputs. This makes the arbitrary first name truthful without making the whole installer
secret directory writable.

The keeper provisions that arbitrary agent's LiteLLM credential only after its owned resource has
been durably reserved and before runtime reconciliation can start it. It creates the plaintext key
locally first, then submits that exact value to the on-box gateway with only the installation's five
purpose aliases, a `$5` budget resetting every `1d`, and the LLM-only route preset. Reconciliation
looks the key up by SHA-256 in a POST body and refuses changed remote policy. A lost create response
therefore cannot orphan an unrecoverable credential or cause a retry to mint a second key. Existing
installations may retain exact per-name `runtime.gatewayKeys`; those always take precedence. Owned
agent deletion revokes a keeper-managed key by hash before removing its local file; it never revokes
or removes an exact installation-supplied key.

Creation is not successful merely because Compose accepted `up -d`. Keeper waits for the new
runtime's unauthenticated Eve health response on its keeper-owned private address and leaves the
resource pending for explicit reconciliation if the process does not become ready. Only that health-gated
success sends the owner from `/agents/new` directly to the named agent's chat page. A failed optional
Git definition backup remains visible there but does not falsely mark the healthy local runtime as
failed.

### What changes

1. **The wizard is shorter.** Fewer questions stand between "run the install command" and a
   working conversation than the ten-step table above. The exact revised step count and order is
   a build decision for the wave that implements this (see Open questions); this ADR fixes the
   *shape* — model key tested, then a conversation — not the final count.
2. **Web chat in the console is the first door.** The owner reaches a working conversation with
   their agent before connecting Slack or Telegram, using the console's own chat surface against
   eve's existing (and already password-gated) HTTP session route. Slack/Telegram setup moves
   after first conversation, not before it.

   **Approvals can be answered there, and here is exactly what that trusts** (owner decision B3,
   wave 8). Without this, a fresh installation with no chat app connected could never approve
   anything at all, so every gated action would be unreachable on the tested path. The signed-in
   console address is what counts as the approver: the console checks the session cookie, then
   tells the agent which member it is acting for, over the connection it has already authenticated
   with the agent's own route password.

   The honest limit, stated rather than left to be discovered: **anything holding an agent's route
   password can claim to be any member, and so can approve anything that member could.** Today
   that is the console container and the keeper, both on the owner's own server. A browser cannot
   do it — the console replaces whatever identity header the browser sent with the one it verified,
   and the agent reads that header only after the password has checked out — but a route password
   that leaks is not merely a way to talk to the agent, it is a way to authorise its actions. Treat
   it accordingly: it is a secret file, never an environment variable, and rotating it is the
   response to any suspicion that it has been seen.

   The address is still checked against the agent's own allow-list, which is the same list of
   members the console admits at sign-in. An unset or empty list admits nobody.
3. **"Restore from a backup" moves to the very first screen**, offered alongside "start fresh",
   instead of living only as a separate install-command flag and a step-8 wizard page.
4. **The model key is tested with a real completion**, kept exactly as designed in the current
   spec's step 2, but called out here as the first thing the shortened wizard proves, not one
   step among ten.
5. **Wording changes everywhere:** "supported" becomes "tested path". This is a documentation and
   console-copy change, not a change in what is actually tested.
6. **Mac is explicitly labelled best-effort.** The current spec already records Mac's known
   differences so they are "not re-discovered" later; this ADR adds the formal label — expected
   to work, not rehearsed, not the tested path.

### What stays

- One box. The keeper. The on-box gateway. Caddy as the one public listener. The one-time setup
  link (`docs/specs/…` Part 2, step 9). The spend-cap defaults named above — see LAR-53 for
  whether they have since changed.
- Single-user at launch; everything else in the current spec's Part 1–3 (what runs on one box,
  the install command's pre-flight/base/images/secrets steps, the keeper's fixed action list) is
  unchanged by this ADR.

### No promised support

The owner's words, recorded once, exactly:

> "there is NO promised support on open source — that's a community Slack channel with an agent,
> and I will chime in. Numbers will be LOW."

The README must therefore say: this is a **tested path**, not supported software; help is a
community Slack channel with an agent answering questions, and the owner will occasionally
answer personally; expected volumes are low; Mac is best-effort, not tested.

## Consequences

**Positive:**
- A shorter path to a working conversation addresses the loudest first-hour complaint in report
  10's practitioner sweep (intimidating setup, "trust me bro" silence before the owner sees the
  agent do anything) more directly than the current ten-step, doors-before-chat wizard does.
- Restore-first reduces the chance that a destroyed server becomes a panic instead of a known
  procedure — the recovery kit and restore mode already exist in the current spec; this only
  moves the entry point.

**Negative / accepted trade-offs:**
- Web-chat-first requires building real console UI against eve's HTTP session routes, which
  nothing in the console uses today (confirmed by search) — this is new, not yet started work,
  not a reshuffle of existing screens.
- The eve web-chat building blocks this ADR assumes (`eve/next`, `eve/react`, `eve/client`) could
  not be verified against the actually-pinned package in this pass, because this worktree has no
  installed dependencies and installing them was out of scope for a docs-only task. This must be
  confirmed — against whatever eve version is pinned at build time (ADR-0021) — before console
  work starts, not assumed from upstream research alone.
- "No promised support" is a real trade-off for anyone expecting responsiveness; stating it
  plainly in the README is the honest choice, not a marketing softening of it.

## Operational rules

- Do: verify the model key with a real completion before saving it, on the first screen that
  needs one.
- Do: offer restore on the very first screen, before any other question.
- Do: say "tested path" in every place the docs or console currently would have said "supported".
- Do: finish the installer at the first-agent setup page when no agent runtime exists yet, and say
  plainly that the conversation is not ready.
- Don't: print `/chat`, probe agent health, or say "say hello" until an agent has been created,
  reconciled, given a registered gateway key and proved reachable through web chat.
- Don't: build web-chat-first console UI before confirming, against the actually-pinned eve
  version, which client building blocks it ships.
- Don't: promise a support SLA, a response time, or a numbered community size.

## Open questions

- The exact revised wizard step count and order once web chat and restore-first are inserted — a
  slice-level build decision, not fixed by this ADR.
- The exact shape of eve's web-chat exports on the 0.60.x line ADR-0021 moves to (they exist in
  the installed 0.32.0 — see Context); to be re-read when the console work starts.
- LAR-53's exact wording on the spend-cap defaults — see LAR-53.

## Cross-references

- `docs/specs/2026-09-14-lares-installer-and-wizard-design.md` (amended by this ADR)
- ADR-0015 (agents are definitions), ADR-0021 (releases and upgrades — governs which eve version
  is pinned when the web-chat building blocks are next checked)
- Research reports `05` (eve web chat, upstream), `10` (practitioner sweep — first-hour friction)
