# System-prompt differences already explained

`system-prompt-<role>.txt` is not a byte-identity gate (see `README.md`'s
"`system-prompt-<role>.txt` is EXPECTED to differ after the bump"). `scripts/snapshot-compare.sh`
diffs it anyway and prints whatever it finds, but never fails the comparison on it — a system-prompt
line is eve's to reword. This file is the running record of which added/removed lines have already
been looked at and judged harmless, so `snapshot:compare`'s output can tell a reviewer "known" from
"new since the last time someone looked."

Each entry: the exact line (as it appears in the diff, `+` or `-` prefix and all), which role, which
slice/commit found it, and why it is harmless. `snapshot:compare` matches diff lines against this
file by exact substring; anything in the diff that is NOT here is unexplained and must be written up
in `AFTER-0.60.1.md` (or its successor) before the wave proceeds, even though the script itself will
not have failed its exit code for it.

## chief-of-staff

- `+Dynamic skill announcements replace earlier dynamic skills and override static skills with the same name. Static skills omitted from a dynamic announcement remain available.`
  Exact line as captured by `snapshot:compare` on 2026-09-19 (see `AFTER-0.60.1.md`); W2-s7's own
  scratch capture (notes, `docs/…/WAVE-2-NOTES.md` "After W2-s7") described the same addition in
  paraphrase ("Dynamic skill announcements replace earlier dynamic skills…") — this is the exact
  wording, not a second, different change.
  Found: W2-s7 (a25d46a), re-confirmed byte-for-byte: W2-s11.
  Why harmless: one line inside eve's own "Available skills" preamble — eve explaining its own
  skill-announcement precedence rule (a dynamic announcement supersedes a static skill of the same
  name; unrelated static skills stay listed). It does not touch our persona, does not add or remove
  a capability either role grants, and is not something either service configures.

No other role has a known/explained system-prompt difference. travel and creative are expected to
stay byte-identical (W2-s7's scratch capture found none, and this slice re-confirmed it against the
committed BEFORE files).
