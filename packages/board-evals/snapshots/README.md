# The BEFORE/AFTER snapshots — what each role's model is handed

ADR-0015 rule 11: *"For each, the runtime-assembled instructions and tool list must equal today's
build-time ones exactly."* These six files are that "today", written down.

They are the **only** record of what the model saw on the eve version named below. Once the
lockfile moves, that version's answers cannot be asked for again. Treat them as evidence, not as
generated output: they are regenerated only by a deliberate, reviewed change, and a diff here is
the finding, never a chore to be re-baselined away.

| file | what it is |
|---|---|
| `instructions-<role>.txt` | the assembled `services/<role>/agent/persona.md`, byte for byte |
| `system-prompt-<role>.txt` | the WHOLE system prompt eve sent, of which the above is one ingredient |
| `tools-<role>.txt` | the tool names eve handed the model, one per line, sorted |

## Captured on

- **eve `0.32.0`** (`services/<role>/package.json` → `dependencies.eve`), 2026-09-19, against each
  role's **neutral default** `agent.json` + `agent/voice.md` — no installation's persona.
- **Refreshed on `main`** on 2026-09-19, still on eve `0.32.0`, immediately before the eve 0.60.1
  upgrade branch was merged in (`chore(evals): refresh the BEFORE snapshot on main before merging
  the eve upgrade`). The refresh captures `main`'s own drift since the branch point and nothing
  else: chief-of-staff gained one tool, `memory_used`, and the persona text that came with the
  memory work. Travel and creative are unchanged from the first capture. The numbers below are the
  refreshed ones — they are what the AFTER comparison is diffed against.
- Counts at capture:

  | role | tools | instructions | system prompt |
  |---|---|---|---|
  | chief-of-staff | 78 | 30 104 B | 32 185 B |
  | travel | 24 | 13 688 B | 14 279 B |
  | creative | 9 | 5 345 B | 5 620 B |

## How to reproduce them

```
pnpm -C packages/board-evals run snapshot:capture   # rewrites all six files
pnpm -C packages/board-evals run snapshot:check     # the gate: non-empty, sorted, no duplicates
```

Needs `docker`, `psql` and `node`. Nothing reaches a network, a gateway, a box or an outside
account: the model is eve's own in-process mock (`EVE_MOCK_AUTHORED_MODELS=1`) and Postgres is a
disposable `docker run --rm` container per role.

## Where each half comes from, exactly

**Instructions.** `pnpm -C services/<role> run assemble:check` first — it fails if the committed
`agent/persona.md` is not what the assembler produces today — then a byte-for-byte copy of that
file. Nothing is re-rendered, so there is nothing to vary.

**System prompt.** `instructions-<role>.txt` is *ours*, so on its own it says nothing about what an
eve upgrade does to the prompt. `system-prompt-<role>.txt` is the whole thing: read from the
`gen_ai.system_instructions` attribute on the **same** model-call span, in the **same** single
capture run, available because each role's `agent/instrumentation.ts` sets `recordInputs: true`.
It contains eve's own preamble ("Tool execution", and for chief-of-staff "Available skills"), the
persona, and our dynamic instruction blocks, in the order and with the merge eve really applied.
On 0.32 eve sends exactly **one** text block for all three roles; the capture logs the block count
so a release that splits the prompt is visible rather than silently concatenated away.

**Tools.** Read out of eve's own runtime, not recomputed. `scripts/capture-snapshot.sh` drives one
real `eve invoke` per role and reads the `gen_ai.tool.definitions` attribute off the model-call
span the service's existing `agent/instrumentation.ts` exports over OTLP — pointed at a throwaway
local sink through that file's own `LANGFUSE_HOST` / `LANGFUSE_KEY_FILE` environment overrides.
That attribute is the merged list eve actually handed the model: eve's framework tools, the
authored tools, the extension contributions and everything the per-session dynamic resolver
emitted. The capture never imports `grantedToolNames`, `@lares/agent-kit` or a compiled manifest,
so a logic error inside the resolver would show up here rather than hide behind itself.

The prompt is the literal word `hello`, which matches no tool name, so eve's mock dispatches
nothing: the span is emitted and no tool's `execute()` runs.

## The normalisation, in full — apply the identical one to the AFTER capture

### `tools-<role>.txt`

1. **Tool names only.** Descriptions and input schemas are discarded. They are the noisiest part
   of the payload and the least meaningful to diff; what rule 11 is about is which tools exist.
2. **`LC_ALL=C sort -u`.** The wire order is eve's registration order and is not a promise. Sorting
   under the C locale makes the file stable and a diff readable; `-u` collapses the duplicate a
   second model call would add.
3. **One name per line, trailing newline, no blank lines.** The gate test asserts this.

### `system-prompt-<role>.txt`

Written out byte for byte except for **two clock rewrites**, both applied by one `sed -E` in
`scripts/capture-snapshot.sh`. Copy them verbatim; do not improve them.

4. **The clock block's instant.** Any line matching
   `^It is .*, HH:MM \((.*)\)\. In UTC that instant is .*\.$` becomes
   `It is <NORMALISED-CLOCK> (\1). In UTC that instant is <NORMALISED-CLOCK-UTC>.`
   Source: `buildClockMarkdown` (`@lares/agent-kit`), in the chief-of-staff prompt's `## Now`
   block. The **timezone is left visible on purpose** — it comes from our settings, not from eve,
   so a change there is a finding, not noise.
5. **A standalone ISO date.** Any line that is exactly `YYYY-MM-DD` becomes `<NORMALISED-DATE>`.
   Today that is one line, under the travel persona's `## I dag` heading. Matched on the whole
   line rather than on the heading above it deliberately: a release that renames the heading then
   still gets its date normalised instead of quietly leaking one.
6. **One trailing newline**, and nothing else is rewritten. Those two lines are the only volatile
   content in the 0.32.0 payload: after them, the three files contain no other clock value, no
   session, trace or span id and no absolute path. Proven by capturing twice — the second run's
   three files were byte-identical to the first's.

If a later capture contains something volatile these rules do not cover, add a rule here
explicitly and write down what you did. Do not let a smarter script hide it.

## `system-prompt-<role>.txt` is EXPECTED to differ after the bump

This file is not a "must stay identical" gate and must never be treated as one. Much of it is
eve's own wording, and a release is entitled to change it. **W2-s11's job is to explain every
differing line, not to demand zero.** A line that differs because eve reworded its own preamble is
a finding to write down and move past; a line that differs because our persona stopped being
merged in, because a block lost its place in the order, or because a permission or safety sentence
vanished is a stop-the-bump finding. The gate test here asserts only that the file exists, is not
empty, and still contains the persona's first heading.

`tools-<role>.txt` is the opposite: a difference there is a change in what the model may DO, and
each one needs an answer before the bump lands.

## What these files do NOT capture

- **Anything but the names**, in the tool list. A tool whose description or input schema changes
  under the new eve is invisible in `tools-<role>.txt`.
- **Per-turn and per-session variation.** One session, one turn, one model call, with no mounted
  definition directory and no installation settings. A tool that only appears for a particular
  owner, a particular channel or a later turn is not here.
- **Whether a tool works.** Nothing is executed. A tool present in this list may still fail on its
  first real call.
- **Approval behaviour.** Whether a tool is gated, and by which board, is not part of the name.
