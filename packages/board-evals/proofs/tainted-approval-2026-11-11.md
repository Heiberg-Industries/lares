# Does the tainted-turn approval actually find the taint? (eve 1.0.0-rc.9)

Measured 2026-11-11 against eve 1.0.0-rc.9, by `../scripts/tainted-approval-proof.mjs`. The same
proof on eve 0.60.1 is `tainted-approval-2026-09-20.md`, which has the full argument for why three
keys built from three different framework surfaces have to be seen to agree. Re-run it with

```sh
node packages/board-evals/scripts/tainted-approval-proof.mjs
```

Docker running. A real eve runtime, a real Postgres, a scripted model, no credential. The probes
import the real `asksAfterUntrustedText`, `taintTurn`, `turnKeyFrom` and `clearTurn` from the kit.

## What changed in the method

The hook is the roles' `agent/hooks/origin-taint.ts` reduced to one tool, on the events eve 1.0
has: `call.settled` (the tool's name read from the session view by call id) and the turn
boundaries `turn.started` and `turn.settled`.

Question 4b is restated. On eve 0.60.1 an approved call resumed in a brand-new turn, and the
question was whether the policy, consulted again there, would park a second time. On eve 1.0 the
approved call resumes in the SAME turn. What the question protects is asserted directly: one
approval is enough, the call runs exactly once, and no second card is raised. Whether the policy is
consulted again on the way is recorded as evidence.

## Result — all seven questions pass

| # | question | verdict | evidence |
| --- | --- | --- | --- |
| 1 | the policy finds a taint written by both writers in the same turn | PASS | execute `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_1` · hook `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_1` · policy `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_1` · 1 card · verdict "user-approval" |
| 1b | the bare `approval: asksAfterUntrustedText()` expression parks too (the wrapper is not what made the card) | PASS | 1 card · taint written under `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_3` (execute) and `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_3` (hook) · ran after approval |
| 2 | an untainted turn raises NO card and still runs | PASS | 0 cards · policy key `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_0` · verdict "not-applicable" · ran |
| 3 | turn N's taint does not raise a card in turn N+1 of the same session | PASS | 0 cards · t2 tainted `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_1`, t3 looked up `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_2` · 1 turn-boundary clear(s) fired for t2's turn |
| 4 | the approved call executes, and the turn id it sees there | PASS | ran · park turn `turn_1` (seq 1) → execute turn `turn_1` (seq 1) — SAME turn id |
| 4b | one approval is enough: the approved call runs exactly once and no second card is raised | PASS | ran 1 time(s) · open cards after the approval: 0 · request ended "completed" · the policy was consulted again on resume: `turn_1` → "user-approval" |
| 5 | hook, policy and execute share one process (the taint map is module-level memory) | PASS | pids [57611] |
| turn | what ran | execute-side taint key | hook-side taint key | policy lookup key | verdict | card |
| --- | --- | --- | --- | --- | --- | --- |
| t1 | gated_probe | — | — | `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_0` | `"not-applicable"` | 0 |
| t2 | taint_reader → gated_probe | `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_1` | `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_1` | `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_1` | `"user-approval"` | 1 |
| t3 | gated_probe | — | — | `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_2` | `"not-applicable"` | 0 |
| t4 | taint_reader → gated_plain | `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_3` | `wrun_01M75F6SVY1NHC5W8A6SX4VK0F/turn_3` | _unwrapped_ | _unwrapped_ | 1 |

`TAINTED APPROVAL: PASS`. The three keys agree (`<session>/turn_N` from the tool's context, the
hook's event and the approval context), a card appears exactly in the tainted turns, the taint does
not carry into the next turn, and hook, policy and execution share one process.

Two facts about eve 1.0 this run shows: the approved call executes in the turn that asked (same
turn id and sequence), and the policy IS consulted again when it resumes. In the tainted turn that
second consult answers "user-approval" again, and the approval already given stands: the call ran
once and no card was left open.
