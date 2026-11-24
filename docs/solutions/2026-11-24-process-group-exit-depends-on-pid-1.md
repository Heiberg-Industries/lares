# Waiting for a killed process group depends on PID 1

Date: 2026-11-24. Area: the owner bootstrap's preflight stop logic
(`services/box/ops/owner-bootstrap.py`) and its safety tests
(`services/box/tests/owner-bootstrap-safety.py`). Fixed in
[#448](https://github.com/Heiberg-Industries/lares/pull/448).

## Symptom

Three tests in `OwnerBootstrapSafetyTests` failed every time on some machines and never on others:
`test_run_timeout_preserves_settings_and_releases_lock_for_retry`,
`test_timeout_kills_sigterm_ignoring_descendant_before_confirming_cleanup` and
`test_timeout_stops_process_and_targets_only_generated_container_id`. Each raised
`PreflightCleanupUnconfirmed` from `run_preflight` after a timeout. Run directly as a normal user, the
suite ended `Ran 15 tests ... FAILED (errors=3)`. The production code was correct.

## Cause

`stop_preflight_process` sends SIGTERM, then SIGKILL, to the preflight's process group, and after each
waits up to `PREFLIGHT_STOP_GRACE_SECONDS` for `os.killpg(pgid, 0)` to raise `ProcessLookupError`. A
killed process whose parent has already exited stays a zombie, and `killpg(pgid, 0)` keeps succeeding on
a zombie until PID 1 reaps it. How long a dead group stays visible is therefore a property of the
environment's PID 1, not of the code under test.

| PID 1 | Group still visible after the leader was reaped |
| --- | --- |
| reaps orphans immediately | about 0 ms (measured with a stand-in init, see below) |
| a sandbox whose PID 1 reaps orphans slowly | 1.3-1.9 s, mostly about 1.65 s, over repeated trials as root and as a normal user |
| never reaps orphans | forever |

The tests patched the grace to 0.1-0.2 s, shorter than the slow case, so `stopped` came back `False`.
The production grace is 3 s.

## What changed

- One named constant, `TEST_STOP_GRACE_SECONDS = 3`, replaces the five tiny grace patches. The wait
  returns as soon as the group is gone, so a prompt init only pays for the one test that must wait out
  a whole SIGTERM window (a descendant that ignores SIGTERM). The tiny `PREFLIGHT_TIMEOUT_SECONDS` values
  stay; they are what makes the timeout fire quickly.
- The vitest wrapper `owner-bootstrap.test.ts` got a 60 s timeout.
- The tests that expect `PreflightCleanupUnconfirmed` now also prove the process group was stopped.

Suite time, as a normal user: slow-reaping sandbox 2.3 s before and about 15 s after; prompt-reaping init
about 1.3 s before and about 4.1 s after.

## Rules for next time

1. Size a wait for "the process group is gone" for the slowest init the tests must run on, and let the
   wait return early. A roomy value costs nothing except in a test that must wait out a full signal window.
2. A test that expects an exception must also show why. `assertRaises(PreflightCleanupUnconfirmed)` is
   satisfied by a process that would not stop and by a missing container id alike. Record the outcome of
   the step that should have succeeded (`stop_spy` in the test file) and assert that what should not have
   happened did not (no `docker` command ran).
3. Check that a branch is reached when run as the user who runs the tests. `remove_preflight_container`
   checks file ownership before it checks for an empty id, so for a file written by a non-root test user
   the "empty id" case was turned away at the ownership check and never tested emptiness. Patch
   `is_root_owned`, as the sibling cleanup test does.
4. A vitest test that shells out to a long Python suite needs its own timeout; the default is 5 s. The
   convention in `services/box/tests` is a third argument such as `60_000`.
5. These tests refuse to run as root (they assert that files are not root-owned). Run them as a normal user.

## Reproducing

Measure the delay on a machine (run it as a normal user):

```python
import os, signal, subprocess, time, tempfile
d = tempfile.mkdtemp(); s = os.path.join(d, "slow.sh"); open(s, "w").write("sleep 30\n")
p = subprocess.Popen(["bash", s], start_new_session=True); time.sleep(0.3)
os.killpg(p.pid, signal.SIGTERM); t0 = time.monotonic(); p.wait()
while True:
    try: os.killpg(p.pid, 0)
    except ProcessLookupError: break
    time.sleep(0.01)
print(f"group gone after {(time.monotonic()-t0)*1000:.0f} ms")
```

Run the suite under a chosen PID 1 with a fresh PID namespace (needs root). Save this as `init.py`:

```python
import os, sys

child = os.fork()
if child == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

status = 1
while True:
    try:
        pid, raw = os.waitpid(-1, 0)  # reaps every orphan the moment it dies
    except ChildProcessError:
        break
    if pid == child:
        status = os.waitstatus_to_exitcode(raw)
        break
sys.exit(status)
```

```bash
unshare --pid --fork --kill-child --mount-proc python3 init.py \
  runuser -u <normal-user> -- python3 -B services/box/tests/owner-bootstrap-safety.py
```

To get a PID 1 that never reaps orphans, change `os.waitpid(-1, 0)` to `os.waitpid(child, 0)`.

## Not covered

- Under a PID 1 that never reaps, the suite still fails, as it did before this change. The production
  stop logic fails closed there too: it cannot confirm the group is gone while zombies persist. The
  missing/empty-id test, which used to pass there for the wrong reason, now fails there on purpose.
  Making the tests independent of the host's PID 1 (a test-owned reaper, for example through
  `PR_SET_CHILD_SUBREAPER`, or a fake group-status check) is a larger redesign and has not been
  prototyped.
- `docker run --init` itself was not run; the stand-in init above was used instead.
