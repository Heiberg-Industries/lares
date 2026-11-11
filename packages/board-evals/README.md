# Agent definition runtime proofs

From the repository root, after the workspace dependencies are installed and Docker is running:

```sh
pnpm -C packages/board-evals run eval
```

This is the single required command. It runs installed, patched eve 1.0.0-rc.9 with `mockModel`, no model credentials, gateway calls, provider setup, or production changes. Every agent it builds also carries the model guard (`agent/instrumentation/model-guard.ts`): the AI SDK's default provider is replaced by one that refuses every request, so a model id that eve re-resolves on a cold pick-up cannot reach a provider either. `tests/model-guard.test.ts` pins that. Docker supplies a disposable `pgvector/pgvector:pg16` database; it does not build an image. Every process runs from a newly created temporary fixture and owns its workflow history. Existing repository `.eve`, `.output`, and workflow state are neither read nor deleted. Runs are serialized (`--max-concurrency 1`). Allow roughly six minutes for fresh builds and restart processes.

| Required behavior | Committed proof |
| --- | --- |
| Granted subset | `definition.eval.ts`: actual mounted `agent.json` → shared `resolveDefinition`/validation/Postgres cache → `grantedToolNames` → model-visible pool tools across Vault/Gmail grant changes; next session loses revoked tool while old session retains it |
| Approval survives restart | `scripts/restart-proof.mjs`: authored control and definition-selected catalogue tool park on approval; entire owned process group exits; another process approves against identical compiled output; exactly one logged side effect |
| Board flip bites | `board.eval.ts`: the next call after a flip observes gated/never/autonomous |
| Always-ask holds | `board.eval.ts`: Gmail send still asks under autonomous; a denial sends nothing |
| No stale level, and fail-closed read | `board.eval.ts`: the board is read fresh for every decision, so with the fixture clock unmoved a level switched to never refuses the very next call and one switched back runs it (the kit has no cache: a cached level let a revoked permission keep running); an unreadable board asks, and the failure leaves nothing behind |
| Conversation language | `language.eval.ts`: actual `set_language` affects next turn, stays out of another conversation and leaves the definition file unchanged |
| Invalid definition fails closed | `definition.eval.ts`: malformed JSON and invalid model alias preserve real last-valid duties/tool grants and DB invalid status; without cache, zero model invocations; repair between failure and fallback stays refused, a new valid conversation recovers |
| Schedule next tick | `schedules.eval.ts`: actual eve dispatch runs the authored handler and current shared definition/schedule gate on each on/off/on tick; separate run with `EVE_SCHEDULES_LIVE=0` executes zero ticks |

`doors.eval.ts` is additional evidence: an actual compiled Telegram adapter with a disabled definition and no token permits a mock turn without credential resolution or outbound attempts. There are eight required **behaviors**, not eight eval files. The driver checks every expected result id and `verdict: passed`, so skipped or missing evals fail. Only then does it print:

```text
EIGHT BEHAVIORS PASS: 8/8 required + disabled-door supplemental proof; mock models only.
```

No environment setup is required. The driver creates `BOARD_LEVELS`, `BOARD_SKEW`, `BOARD_LOG`, `BOARD_EVENTS`, `PROOF_MODEL_LOG`, `SEAM_GRANTS` (empty legacy control), `LARES_DEFINITION_DIR`, and `DATABASE_URL`. It installs synthetic managed resource/owner-claim records in its own database for the shared approval-authority guard. It explicitly sets the schedule switch per phase and excludes inherited gateway credentials, owner settings and workflow database URLs. `NODE_ENV=production` is deliberate: eve uses a bootstrap model in test mode. The local eval dev server still provides schedule dispatch.

The runner always rebuilds its fresh fixture. The restart proof never rebuilds between its measured halves and hashes **all** compiled output files. eve 1.0 has no one-shot `invoke` command, so the proof starts the built server (`eve start`) for each step, drives it over eve's own HTTP door with `eve/client`, and kills it before the next step. Child completion and absence of that owned process group are checked before each next server starts; no global `pgrep` or unrelated process cleanup occurs. SIGINT/SIGTERM and command timeouts clean up owned child groups, directories and the disposable container. A hard SIGKILL cannot run JavaScript cleanup; testcontainers' resource reaper remains the container backstop.

The deliberately memoryless model can propose the same action again after each restart. Three later cards are denied in fresh processes, each asserting zero additional effects. This proves denial safety, not model settlement. The remaining pending proposal belongs only to the disposable world, which cleanup removes. Standalone restart command:

```sh
bash packages/board-evals/scripts/restart-probe.sh
```

The real cold-invalid test once discovered that eve caught dynamic resolver errors and fell back to its compiled model. eve 1.0 has no compiled fallback (a failed dynamic model fails the turn); `@lares/agent-kit/definition-model` still guards the provider boundary in every role and this fixture using a durable session readiness marker checked before either provider streaming method. A failed resolution cannot become ready because a file is repaired later. Successful last-valid resolution remains ready; neutral unmounted runtimes require no marker. This guards new model work; it does not cancel a tool already executing or claim to repair pre-existing queued continuations.

Installed API evidence: `eve/docs/evals/cases.mdx` documents `t.session()` and turn event access; `targets.mdx` documents `t.target.dispatchSchedule()`; `schedules.mdx` states dispatch uses the production cron path. A failed model turn does not end the session, so cold refusal asserts a `turn.settled` event with outcome `failed` plus zero model calls, not session status alone.

## Real-framework proofs

Each one boots a real eve runtime against a disposable Postgres with a scripted model — no credential, no gateway. Run by hand, results committed under `proofs/` (one dated file per run; the records dated before November 2026 are the same proofs on eve 0.60.1 and stay as history).

| What it settles | Command | Results |
| --- | --- | --- |
| The hash on the approval card equals the hash at execution, and `ctx.callId` is the card's call id | `node scripts/approval-binding-proof.mjs` | `proofs/approval-binding-2026-09-20.md` |
| A tainted turn raises a card and an untainted one does not, under the real turn ids | `node scripts/tainted-approval-proof.mjs` | `proofs/tainted-approval-2026-09-20.md` |
| The console's chat proxy really carries a turn: the agent's own Basic-gated door, the real `forwardChat`, eve's own browser `Client`, a reconnecting stream, and the wire shape of an approval | `pnpm -C packages/board-evals run proof:web-chat` | `proofs/web-chat-2026-09-20.md` |

`seams.eval.ts` and `replay.eval.ts` remain separately available as measurements of eve's dynamic seams: `node scripts/all-evals.mjs --seams-only` runs both in a fixture with no mounted definition. They are not the required suite, and their file-driven `SEAM_GRANTS` is not definition authorization evidence. Neither hands eve a model id (the model-id routing probe an early version carried is gone; this project never gives eve a bare model id). `scripts/doors-probe.mjs` remains a standalone isolated supplemental probe.
