# A "never crash" safety net that hid a fail-closed agent (LAR-105)

**Problem.** An agent whose mounted definition was unusable, with no last-valid row to fall back
to, answered `/eve/v1/health` in about 20 s and then failed every conversation. The keeper's
one-minute health wait reported it healthy, so a switch would have finished "done" on an agent
that could not work. Found by the LAR-98 dry rehearsal (`scripts/rehearsal/first-start.py
--no-last-valid`).

**Cause.** Two pieces of code disagreed, and the quieter one won.

- `packages/agent-kit/src/definition-cache.ts` throws "no last valid one to fall back to" and says
  why: *fail closed, loudly, and let the container restart loop be visible.*
- Each role's `agent/instrumentation.ts` resolved the boot definition inside a fire-and-forget
  promise with a `.catch` that logged `[registry] agent not registered`. That catch existed so a
  failure to *register with the console's agent list* could never kill an agent, but it also caught
  the fail-closed throw. The agent stayed up, and every session re-resolved the same unusable
  definition and failed.

**Fix (pull request #47).**

1. `packages/agent-kit/src/boot-definition.ts`: `bootDefinitionOrStop(resolve)` awaits the
   resolve and, on any failure, prints one plain line and exits 78 (EX_CONFIG, as in
   `images/agent-runtime/start.sh`).
2. Each role awaits it **at module level** in `instrumentation.ts`, after the LAR-73 lock release.
   The built server evaluates that module to the end before it opens its port, so the agent stops
   before health can ever answer. eve's `setup` is not awaited, so putting the check there would
   have raced the health probe.
3. `setup` registers from the already-resolved definition; registration failure is still only a
   log line.
4. Keeper: `AgentNotHealthyError` from `services/keeper/lib/docker.ts`; `lifecycle.ts` stores
   `AGENT_NOT_HEALTHY`, a plain sentence the console shows, instead of "Runtime reconciliation in
   progress".

**Lesson.** When a catch exists to keep one *side effect* non-fatal, make sure the call inside it
does only that side effect. Here the try block also did the load-bearing work (resolving the
definition), so a guard meant for "the console list is unreachable" also swallowed "there is
nothing to run on". Separate the load-bearing step from the optional one, and let the
load-bearing one fail the way its own module says it should.

**How to see it.** `pnpm -C packages/agent-kit exec vitest run tests/definition-cache.test.ts -t
bootDefinitionOrStop` (Docker running), and in the keeper `tests/lifecycle.test.ts -t LAR-105`.
On a server: a broken mounted definition with no `agent_definitions` row makes the container
restart repeatedly, logging `[definition] this agent has no usable definition, so it is not
starting: …`.
