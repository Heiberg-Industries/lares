# AFTER — eve 0.60.1, re-measured on this tree (W2-s11)

This is the AFTER half of ADR-0015 rule 11's gate. The BEFORE half is
`instructions-<role>.txt`, `system-prompt-<role>.txt` and `tools-<role>.txt` in this directory,
captured on eve `0.32.0` (see `README.md`). **None of those six committed files were edited to
produce this document** — every result below comes from a fresh capture written into a throwaway
temp directory and diffed against the committed files, never the other way round.

## What was compared, and how

Two mechanisms, because only one of them needs Docker:

1. **`pnpm -C packages/board-evals exec vitest run tests/snapshot-gate.test.ts`** — fast, no
   Docker. Asserts the BEFORE files exist, are non-empty and well-formed (tools sorted and
   duplicate-free), and — new in this slice — that the LIVE `services/<role>/agent/persona.md`
   this tree assembles is byte-identical to the committed `instructions-<role>.txt`, for all three
   roles. This is the instructions half of rule 11; it needs no model call.
2. **`pnpm -C packages/board-evals run snapshot:compare`** — Docker-backed, minutes not seconds.
   Runs `scripts/capture-snapshot.sh` (a real `eve invoke` per role against a disposable Postgres,
   reading `gen_ai.tool.definitions` and `gen_ai.system_instructions` off the model-call span) with
   its new `SNAPSHOT_OUT_DIR` override pointed at a temp directory, then diffs all three files per
   role against the committed ones. It exits non-zero on any tools or instructions difference; a
   system-prompt difference is printed and classified against `system-prompt-allowlist.md` but
   never fails the exit code — that file is not a byte-identity gate (see this directory's
   `README.md`, "`system-prompt-<role>.txt` is EXPECTED to differ after the bump").

`scripts/model-visible-tools-probe.sh` was deliberately **not** used, per W2-s1's finding: it is a
verifier that confirms a list of names you already believe in is present (via eve's mock-model
matcher); it prints no list of its own and cannot enumerate what changed. `capture-snapshot.sh` is
the only honest enumerator, because it reads the names eve actually handed the model off the real
span attribute.

Both commands were run against this tree, `HEAD` at the commit this file ships with (eve `0.60.1`
per `services/<role>/package.json` and `packages/board-evals/package.json`), after W2-s9
(instrumentation/tracePolicy), so it includes every fix through that slice: the durable dynamic
catalogue (W2-s7), `task_cancel` disabled by sentinel (W2-s8b), board-evals ported to
`definitionModel` (W2-s10), and the `tracePolicy` addition (W2-s9).

## Result per role

| role | tools | instructions | system prompt |
|---|---|---|---|
| chief-of-staff | 77, **identical set** to the BEFORE snapshot | byte-identical | **1 line added** (see below) |
| travel | 24, identical set | byte-identical | byte-identical |
| creative | 9, identical set | byte-identical | byte-identical |

`snapshot:compare` exit code: **0** (no tool-list or instructions difference on any role). Run time:
about 2.5 minutes for all three roles (one real `eve invoke` each, against a disposable Postgres
container per role).

This reproduces, on the current tree and via the committed method rather than a scratch capture,
exactly what the WAVE-2-NOTES recorded after W2-s7: tool lists 77/24/9 with an EMPTY diff, both
`instructions-<role>.txt` files byte-identical, and `system-prompt-travel.txt` /
`system-prompt-creative.txt` byte-identical. Nothing on this tree has changed that result since.

## The one explained difference

`system-prompt-chief-of-staff.txt` gains exactly one line, inside eve's own "Available skills"
preamble (added directly after "Listed skills are available in this run. Do not claim a listed
skill is inaccessible unless activation or workspace inspection actually fails."):

```
Dynamic skill announcements replace earlier dynamic skills and override static skills with the same name. Static skills omitted from a dynamic announcement remain available.
```

**Why it is harmless:** this is eve's own wording, describing eve's own precedence rule for its
skill-announcement mechanism (a dynamic announcement supersedes a static skill of the same name;
unrelated static skills are unaffected and stay listed). It is not part of either role's persona
(`instructions-chief-of-staff.txt` is unchanged), it does not grant, remove or rename any tool
(`tools-chief-of-staff.txt` is unchanged), and it is not something either service configures — it
appears purely because eve 0.60.1 changed the wording of its own preamble relative to 0.32.0.
Classified: **eve's own wording**. Recorded in `system-prompt-allowlist.md` so a future
`snapshot:compare` run flags it as already explained rather than as new.

No other role has any system-prompt difference to explain.

## What this comparison does NOT cover

Carried over from `README.md`'s own list, because the AFTER capture uses the identical method and
inherits the identical blind spots:

- **Anything but tool names.** A tool whose description or input schema changed under 0.60.1 is
  invisible in `tools-<role>.txt` — only presence/absence of a name is compared.
- **Per-turn and per-session variation.** One session, one turn, one model call, no mounted
  definition directory, no installation settings. A tool that only appears for a particular owner,
  channel, or later turn is not exercised here.
- **Whether a tool works.** Nothing is executed — the capture's prompt is the literal word `hello`,
  which matches no tool name, so the mock model dispatches nothing. A tool present in the list may
  still fail on its first real call.
- **Approval behaviour.** Whether a tool is gated, and by which board, is not part of its name and
  is not checked here.
- **Model choice.** `EVE_MOCK_AUTHORED_MODELS=1` substitutes eve's in-process mock model
  (`runtime/agent/mock-model-adapter.js`); which real model would have served the turn is a
  separate question this capture cannot answer (see WAVE-2-NOTES, "After W2-s3b part 2").

## Before this branch merges

The six committed files here were captured on eve `0.32.0`, against this wave's branch base. `main`
has kept moving since then and will legitimately have gained tools and persona text from other,
unrelated work landing on `main` in the meantime (for example, a new `memory_used` tool in
chief-of-staff) — none of that is a regression from this wave, but it means a same-branch
`git diff` of these files after merging `main` in would show changes that have nothing to do with
the eve upgrade, which is not a comparison anyone could read.

The correct order is therefore: refresh the BEFORE snapshot on `main` **first** (still eve 0.32,
so it captures only `main`'s own drift), merge this wave's branch in, then run the AFTER
comparison on the merged tree — never the other way round, and never by hand-editing these files.

```bash
# 1. On current main (still eve 0.32.0) — refresh BEFORE so it reflects main's own drift only.
git checkout main
pnpm install --frozen-lockfile --prefer-offline
pnpm -C packages/board-evals run snapshot:capture
git add packages/board-evals/snapshots/instructions-*.txt \
        packages/board-evals/snapshots/system-prompt-*.txt \
        packages/board-evals/snapshots/tools-*.txt
git commit -m "chore(evals): refresh the BEFORE snapshot on main before merging the eve upgrade"

# 2. Merge this wave's branch (the eve 0.60.1 upgrade) into main.
git merge eve-upgrade

# 3. Re-install for the merged tree, then run the AFTER comparison against the just-refreshed
#    BEFORE — a difference here is the eve upgrade's effect, not main's unrelated drift.
pnpm install --frozen-lockfile --prefer-offline
pnpm -C packages/board-evals exec vitest run tests/snapshot-gate.test.ts
pnpm -C packages/board-evals run snapshot:compare
```

If step 3's `snapshot:compare` exits non-zero (a tool or instructions difference), or prints an
UNEXPLAINED system-prompt line, the same rule as this slice applies: stop, write the finding down,
do not edit the `.txt` files to make it pass, and get the controller's and owner's decision before
the merge proceeds.

## The merge run — 2026-09-19

Merged `main` (`0e587c2`, the refreshed-BEFORE commit) into the eve 0.60.1 branch as `3fcd357`,
then ran the comparison above on the merged tree. **`snapshot:compare` exit code: 0.**

| role | tools | instructions | system prompt |
|---|---|---|---|
| chief-of-staff | 78, **identical set** to the refreshed BEFORE | byte-identical (30 104 B) | the same 1 allow-listed line, and nothing else (32 185 → 32 359 B) |
| travel | 24, identical set | byte-identical | byte-identical |
| creative | 9, identical set | byte-identical | byte-identical |

The chief-of-staff count is 78 rather than the 77 recorded higher up this file for the same reason
the section above predicted: `main` gained `memory_used` while this branch was open, the BEFORE
snapshot was refreshed on `main` on 0.32 to include it, and 0.60.1 hands the model the same set.
The one differing system-prompt line is unchanged from the W2-s11 run — eve's own "Available
skills" precedence sentence, already in `system-prompt-allowlist.md`. No new difference appeared,
so nothing new needed explaining and no `.txt` file was touched by hand; the three chief-of-staff
files in this directory are `main`'s refreshed capture, taken as-is through the merge conflict.

`bash packages/board-evals/scripts/restart-probe.sh` on the merged tree, first run, no retry:

```
REQUIRED: restart authored control PASS (exited pid 63280 -> new pid 63485; exactly one effect; 3 cancellations added zero effects)
REQUIRED: restart definition catalogue PASS (exited pid 64318 -> new pid 64561; exactly one effect; 3 cancellations added zero effects)
RESTART PROOF PASS: authored control + definition catalogue.
```
