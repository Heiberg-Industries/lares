# Role templates

Three templates live here, each extracted from a running agent, never invented. There is no `pa`
or `accountant` template because no agent exists yet to extract one from —
`packages/agent-kit/tests/templates.test.ts` pins the exact list, growing one entry per
extraction, never ahead of one.

## The three templates, in one line each

- [`chief-of-staff`](chief-of-staff/README.md) — the operating side: inbox, calendar, people,
  stores, the obligation radar. Extracted from Saga.
- [`travel`](travel/README.md) — the trip concierge: places, routes, the trip's state, the
  shopping list. Extracted from Marcel.
- [`creative`](creative/README.md) — the creative director: ideation on a brief, grounded in the
  business knowledge store. Extracted from Calliope.

Read a template's own README first, for what the role does and deliberately does not do. This
doc is the rest of the path: template → a fourth running service, `services/eve-<name>/`, end to
end. Commands below are copy-pasteable; each says whether it runs from the repo root or the
service directory.

## 1. Copy the declaration

From the repo root:

```sh
cp packages/agent-kit/templates/<role>/agent.json services/eve-<name>/agent.json
```

Then edit `services/eve-<name>/agent.json`:

- **Set** `name`, `channels` (which doors this service listens on), `model`.
- **Keep** `"role": "<role>"` and `"persona": "agent/persona.md"` — NOT `agent/instructions.md`.
  eve reads a root `agent/instructions.md` AND `agent/instructions/` **together** (root content
  first, then the sorted directory entries), and since ORB-278 step 2 the persona is injected by
  `agent/instructions/aa-definition.ts` at session start. Putting the assembled file back at
  `agent/instructions.md` would inject the whole persona TWICE. The first records which
  template this agent's instructions are built from, the second is where step 3 writes them.
- **Grants** — drop whatever this installation doesn't need; nothing requires carrying a
  capability just because the template granted it. The one coupled part is `skills`:
  chief-of-staff's `commercial` skill `requires` `twenty` and `orakel` at `read`, and every
  capability a kept skill requires must stay granted at that scope or wider — drop a grant a
  kept skill depends on, or add a skill without its required grants, and the build fails on the
  same never-widen check (verbatim message in step 4).

  **Some grants are named by tool in `role.md`.** The role text is generic about people and
  places, but not about tools: `travel/role.md` instructs the agent to call `place_link`,
  `nearby_places`, `strava_routes`, `shopping_add`, `shopping_remove` and `info` by name, and
  `chief-of-staff/role.md` names `read_url`. Drop the grant behind one of those and **the
  assemble fails** (ORB-210 item 3, `assertRoleToolsAreDeployed` in
  `packages/agent-kit/src/persona/lint.ts`), before anything is written:

  ```
  assemble-instructions: ../../packages/agent-kit/templates/travel/role.md: this role instructs the agent to call `strava_routes`, which this agent does not ship. Either grant the capability behind it, or edit the role text in the same change — the generated section would silently stop naming the tool while the role text kept demanding it.
  ```

  It reads every backticked tool reference in the role text and compares it against the tool
  files this agent ships plus its `framework_tools`. Each template's README carries the
  grant → tool-name table under "Which grants the role text assumes by tool name"; dropping one
  of those grants means editing `role.md` in the same change.

  Tool NAMES, unlike vendor names, are deliberately exempt from `lintRole` — a role saying "call
  `strava_routes`" is naming an interface, not choosing a vendor. That exemption used to hold
  only because `_` blocks the vendor rule's word boundary; it is now explicit
  (`TOOL_NAMES` / `TOOL_NAME_PATTERNS` in
  `packages/agent-kit/src/persona/overlay-vocabulary.ts`), matched as whole identifiers, and the
  bare word "Strava" in prose is still a finding.
- **`egress.sealed` stays `true`, and every `write-with-confirm` grant ships `autonomy: "gated"`**
  (both checked by `packages/agent-kit/tests/templates.test.ts`). Unsealing egress, or walking a
  grant to `"autonomous"`, is a deliberate change an installation makes later on its own agent —
  never a template default; `creative/README.md` describes Calliope's own `studio` walk-up.

  **`autonomy` is not a gate on every write.** It bites only on a tool that carries an approval,
  and a plain `write` grant *cannot* carry one (`assertClassMatchesScope` fails the build on that
  combination). So `"shopping": "gated"` is inert — a `write` grant writes with no card by
  construction, and `write-with-confirm` is the scope that renders one. The test asserts the
  plain-write grants as an exact list per template instead, so adding a cardless write is a red
  test and a decision; each template's README says who those writes reach, under "Writes without
  a card". Read that list before keeping a `write` grant an installation does not need.
- **`framework_tools`** names eve's own built-in tools this agent keeps enabled — today only
  `web_search` is a valid entry (only `travel` declares it; Marcel is the one agent with it
  live). Each service's `tests/agent-declaration.test.ts` asserts it against what `eve build`
  actually compiled, so a stale declaration fails a test, not just a vibe.

## 2. Write `agent/voice.md`

The only hand-written persona file. It may name a person, a company, a language — everything
`role.md` is linted to refuse (step 4). Marcel's is French-inflected Norwegian; Saga's names
Bendik and Heiberg/Lares. Keep it short — how this agent talks, not what it does; "what it
does" is `role.md`, shared and generic.

```sh
mkdir -p services/eve-<name>/agent
$EDITOR services/eve-<name>/agent/voice.md
```

## 3. Wire the three scripts and the Dockerfile check

Add to `services/eve-<name>/package.json` (paths below are relative to the service dir, matching
the three services that already do this):

```json
"scripts": {
  "assemble": "tsx ../../packages/agent-kit/bin/assemble-instructions.ts --agent . --role ../../packages/agent-kit/templates/<role>/role.md --voice agent/voice.md --display <Name> --out agent/persona.md",
  "assemble:check": "tsx ../../packages/agent-kit/bin/assemble-instructions.ts --agent . --role ../../packages/agent-kit/templates/<role>/role.md --voice agent/voice.md --display <Name> --out agent/persona.md --check",
  "build": "pnpm run assemble && eve build"
}
```

Add `"tsx": "^4.19.0"` to `devDependencies`: the Docker image installs with `pnpm install
--filter eve-<name>...`, which never pulls in the root `package.json`'s devDependencies, so `tsx`
has to be the service's own or the assemble step fails inside the image build alone. `build`
chains explicitly (rather than a `prebuild` script) because pnpm 9 does not run `prebuild` here —
no `.npmrc` in this repo sets `enable-pre-post-scripts`.

Add one line to the Dockerfile, immediately before the existing `eve build` line:

```dockerfile
RUN pnpm run assemble:check
RUN pnpm exec eve build
```

The image compiles the COMMITTED `agent/persona.md` — `eve build` has no idea `role.md`,
`voice.md` or `agent.json` even exist. `assemble:check` catches a commit that edited one of those
three and forgot to regenerate it: re-assembles in memory, compares byte-for-byte against disk,
writes nothing, fails naming the file if they differ. Run `pnpm run assemble` after any edit and
commit the result.

A clean assemble prints (real output, from Saga's current instructions):

```
assembled agent/persona.md (26254 bytes, 21 capabilities, 66 tool files, 1 skills)
```

"Tool **files**" is literal: that count is every `.ts` under the two tool directories, including
the `disableTool()` sentinel files an agent ships to switch a framework or kit tool OFF. Saga's 66
files are 58 live tools plus 8 sentinels — so this number is expected to sit above what `eve
build` compiles, and step 6 below is how to read the compiled figure.

A clean `assemble:check` prints `assemble-instructions: agent/persona.md is up to date` and
writes nothing; a stale one exits 1 with `agent/persona.md is STALE — it is not what --role
<role.md> + --voice <voice.md> + <agent.json> assemble to. Run the assemble script for this agent
and commit the result`, also writing nothing.

## 4. `eve build` — the three ways it refuses to run

`pnpm run build` (service dir) runs `assemble` before `eve build`, and three checks inside that
assemble step can fail the whole chain before `eve build` ever starts. All are exact strings
from the source below — verified live against a scratch fixture, not paraphrased.

**A `role.md` that isn't generic** (`assertRoleIsGeneric`,
`packages/agent-kit/src/persona/lint.ts`) — naming a real person, company, vendor, place or
language means it's a real agent's persona with the serial numbers still on, not a template:

```
../../packages/agent-kit/templates/chief-of-staff/role.md: this role isn't generic yet — remove the following before it can ship as a template:
line 1: person "Bendik"
```

**A `role.md` naming a tool this agent does not ship** (`assertRoleToolsAreDeployed`, same file) —
the verbatim message is in step 1 above, under "Some grants are named by tool in `role.md`".

**A skill asking for more than the grants give it** (`assertSkillsWithinGrants`,
`packages/agent-kit/src/manifest.ts`) — the never-widen rule, shown here for a `commercial`
skill that requires `orakel` at `write` when the grant is only `read`:

```
agent.json: skill "commercial" requires "orakel" at "write", but the grant is only "read" — a skill can never widen access
```

## 5. Compose + secrets

Not repeated here — this part is about a specific box, not the general recipe. Follow
`docs/runbooks/eve-saga.md` § "Rollback" for the shape of the `compose.yaml` block, § "Egress —
sealed" for the nft allow-list a new sealed agent needs, and § "Gotchas paid for once already"
for deploy discipline (`--no-deps`, `compose-drift-guard.sh --accept`, why a secret is read at
request time and never at import).

## 6. Reading what actually shipped

The generated "where I run" section of `agent/persona.md` lists only tool names found under
`agent/tools/*.ts` and `agent/extensions/agent-kit/tools/*.ts` (`deployedToolsFor`,
`packages/agent-kit/src/persona/deployed-tools.ts`) — never a capability doc's fleet-wide union.
That's the cheap, filesystem-only view; a file can exist there and still not ship (a
`disableTool()` sentinel, a scope check `eve build` applies). The authoritative answer is what
`eve build` actually compiled:

```sh
cd services/eve-<name>
node -e 'console.log(require("./.output/.eve/compile/compiled-agent-manifest.json").tools.map(t=>t.name).sort().join(", "))'
```

Each service's `tests/agent-declaration.test.ts` checks the generated section against this same
compiled file — every backticked tool name in the committed `persona.md` must appear in it —
and the `framework_tools` check from step 1 reads it too. `.output/` is a gitignored build
artifact, so both checks are *skipped*, not failed, when it's missing. Run `pnpm run build`
before `pnpm test` (service dir) for them to actually run.
