# A test path under /proc hung Linux CI for weeks (LAR-81)

**Problem.** From 19 September the travel agent's tests hung on GitHub's Linux runners every
time and never on a Mac, so `services/travel` was left out of the `tests` workflow. Both test
workers ran at full CPU, and vitest's 5 s test timeout never fired. Days of bisection suspected
date and time-zone arithmetic and found nothing.

**Cause.** Two tests stood in for "a folder that cannot be written" with a path under `/proc`:
`writePosition("/proc/nope/nope", …)` in `tests/proximity.test.ts` and
`writeSweepMarker("/proc/nonexistent/nope", …)` in `tests/sweep-marker.test.ts`. Both helpers call
`fs.mkdirSync(dir, { recursive: true })`. On Linux, Node's recursive mkdir under `/proc` never
returns: it spins synchronously, so no timer, timeout or reporter can run. On a Mac `/proc` does not
exist, and the call fails at once.

**How it was found.** A throwaway workflow ran each test file alone under a 90 s cap
(`timeout 90 vitest run <file>` in a bash loop) and printed the file that hit the cap. That named
`proximity.test.ts` in one run, where profiling and whole-suite bisection had not.
`docker run node:24 node -e 'require("fs").mkdirSync("/proc/nope/nope",{recursive:true})'` then
reproduced it in one line. The earlier clue, "`itinerary-advice` is always the last file to
finish", was right: `proximity` sorts next.

**Fix (pull request #56).** Both tests now make a regular file and ask for a folder inside it,
which fails at once with ENOTDIR on every OS and proves the same thing. Travel is back in the
`tests` matrix. Production code is unchanged: the agent only creates its configured data folder.

**Lesson.** Do not use a system path to stand in for "unwritable". `/proc`, `/sys` and `/dev`
behave differently on each OS and can hang instead of failing. Build the failure inside the
test's own temporary folder. And when a test suite hangs with no timeout firing, the code is
blocking synchronously: run each file alone under a hard outer `timeout` before profiling.
