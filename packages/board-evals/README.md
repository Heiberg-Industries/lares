# Agent definition runtime proofs

From the repository root, after the workspace dependencies are installed and Docker is running:

```sh
pnpm -C packages/board-evals run eval
```

This is the single required command for spec Part 8. It runs installed, patched eve 0.32.0 with `mockModel`, no model credentials, gateway calls, provider setup, or production changes. Docker supplies a disposable `postgres:16-alpine` database; it does not build an image. Every process runs from a newly created temporary fixture and owns its workflow history. Existing repository `.eve`, `.output`, and workflow state are neither read nor deleted. Runs are serialized (`--max-concurrency 1`). Allow roughly two minutes for fresh builds and restart processes.

| Required behavior | Committed proof |
| --- | --- |
| Granted subset | `definition.eval.ts`: actual mounted `agent.json` → shared `resolveDefinition`/validation/Postgres cache → `grantedToolNames` → model-visible pool tools across Atlas/Gmail grant changes; next session loses revoked tool while old session retains it |
| Approval survives restart | `scripts/restart-proof.mjs`: authored control and definition-selected catalogue tool park on approval; entire owned process group exits; another process approves against identical compiled output; exactly one logged side effect |
| Board flip bites | `board.eval.ts`: after the documented 30-second cache expires, the next call observes gated/never/autonomous |
| Always-ask holds | `board.eval.ts`: Gmail send still asks under autonomous; cancellation sends nothing |
| Cache and fail-closed read | `board.eval.ts`: deterministic fixture clock proves cached value before expiry, new value after expiry, unreadable board asks and failure is not cached |
| Conversation language | `language.eval.ts`: actual `set_language` affects next turn, stays out of another conversation and leaves the definition file unchanged |
| Invalid definition fails closed | `definition.eval.ts`: malformed JSON and invalid model alias preserve real last-valid duties/tool grants and DB invalid status; without cache, zero model invocations; repair between failure and fallback stays refused, a new valid conversation recovers |
| Schedule next tick | `schedules.eval.ts`: actual eve dispatch runs the authored handler and current shared definition/schedule gate on each on/off/on tick; separate run with `EVE_SCHEDULES_LIVE=0` executes zero ticks |

`doors.eval.ts` is additional Task17 evidence: an actual compiled Telegram adapter with a disabled definition and no token permits a mock turn without credential resolution or outbound attempts. There are eight required **behaviors**, not eight eval files. The driver checks every expected result id and `verdict: passed`, so skipped or missing evals fail. Only then does it print:

```text
EIGHT BEHAVIORS PASS: 8/8 required + disabled-door supplemental proof; mock models only.
```

No environment setup is required. The driver creates `BOARD_LEVELS`, `BOARD_SKEW`, `BOARD_LOG`, `BOARD_EVENTS`, `PROOF_MODEL_LOG`, `SEAM_GRANTS` (empty legacy control), `LARES_DEFINITION_DIR`, and `DATABASE_URL`. It installs synthetic managed resource/owner-claim records in its own database for the shared approval-authority guard. It explicitly sets the schedule switch per phase and excludes inherited gateway credentials, owner settings and workflow database URLs. `NODE_ENV=production` is deliberate: eve uses a bootstrap model in test mode. The local eval dev server still provides schedule dispatch.

The runner always rebuilds its fresh fixture. The restart proof never rebuilds between its measured halves and hashes **all** compiled output files. Eve `invoke`'s exit 3 means input-required. Child completion and absence of that owned process group are checked before each next invocation; no global `pgrep` or unrelated process cleanup occurs. SIGINT/SIGTERM and command timeouts clean up owned child groups, directories and the disposable container. A hard SIGKILL cannot run JavaScript cleanup; testcontainers' resource reaper remains the container backstop.

The deliberately memoryless model can propose the same action again after each restart. Three later cards are cancelled in fresh processes, each asserting zero additional effects. This proves cancellation safety, not model settlement. The remaining pending proposal belongs only to the disposable world, which cleanup removes. Standalone restart command:

```sh
bash packages/board-evals/scripts/restart-probe.sh
```

The real cold-invalid test discovered that eve catches dynamic resolver errors and falls back to its compiled model. `@lares/agent-kit/definition-model` now guards that fallback in all three roles and this fixture using a durable session readiness marker checked before either provider streaming method. A failed resolution cannot become ready because a file is repaired later. Successful last-valid resolution remains ready; neutral unmounted runtimes require no marker. This guards new model work; it does not cancel a tool already executing or claim to repair pre-existing queued continuations.

Installed API evidence: `eve/docs/evals/cases.mdx` documents `t.newSession()` and turn event access; `targets.mdx` documents `t.target.dispatchSchedule()`; `schedules.mdx` states dispatch uses the production cron path. A failed model turn may leave the session `waiting`, so cold refusal asserts `turn.failed` plus zero model calls, not session status alone.

## Real-framework proofs

Each one boots a real eve 0.60.1 runtime against a disposable Postgres with a scripted model — no credential, no gateway. Run by hand, results committed under `proofs/`.

| What it settles | Command | Results |
| --- | --- | --- |
| The hash on the approval card equals the hash at execution, and `ctx.callId` is the card's call id | `node scripts/approval-binding-proof.mjs` | `proofs/approval-binding-2026-09-20.md` |
| A tainted turn raises a card and an untainted one does not, under the real turn ids | `node scripts/tainted-approval-proof.mjs` | `proofs/tainted-approval-2026-09-20.md` |
| The console's chat proxy really carries a turn: the agent's own Basic-gated door, the real `forwardChat`, eve's own browser `Client`, a reconnecting stream, and the wire shape of an approval | `pnpm -C packages/board-evals run proof:web-chat` | `proofs/web-chat-2026-09-20.md` |

Historical `seams.eval.ts` and `replay.eval.ts` remain separately available for earlier dynamic-seam research. They are not the required suite: seams’ Q5 deliberately attempts gateway model-ID routing, and its file-driven `SEAM_GRANTS` is not definition authorization evidence. Do not run that historical probe as part of the mock-only proof. `scripts/doors-probe.mjs` remains a standalone isolated supplemental probe.
