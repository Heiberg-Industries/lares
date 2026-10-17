# Role templates

A template is the engine's description of one role: what the agent is for (`role.md`) and the
declaration it assumes (`agent.json`, with a `definition.json` form the keeper reads). Two live
here, each extracted from a running agent, never invented.
`packages/agent-kit/tests/templates.test.ts` pins the exact list, growing one entry per extraction,
never ahead of one.

- [`chief-of-staff`](chief-of-staff/README.md) — the operating side: inbox, calendar, people,
  stores, the obligation radar.
- [`creative`](creative/README.md) — the creative director: ideation on a brief, grounded in the
  business knowledge store.

Read a template's own README first, for what the role does and deliberately does not do.

## How an installation uses a template

An installation does not copy a template or build anything. The owner creates an agent from a role
on the console's "new agent" page; the keeper saves the agent's definition on the server
(`/srv/lares/agents/<name>/`: `agent.json`, `duties.md`, `voice.md`). The running agent is an
engine image for that role plus the definition, resolved at session start
([ADR-0015](../../../docs/decisions/0015-agents-are-definitions-resolved-at-runtime.md)). The role
text and the engine's safety rules are always part of the agent; what the owner writes in
`duties.md` and `voice.md` is added after them and cannot loosen them. See
[the install guide](../../../docs/install.md).

What an installation may change, in the console: the grants it keeps (any grant a kept skill
requires must stay), the autonomy levels, the doors and the schedules. What it may not: the safety
rules, and the default that egress stays sealed.

## For role authors (contributors to the engine)

The rest of this page is for someone changing a template or adding a role to the engine itself,
not for someone installing Lares. A new role is a pull request to this repository.

### The rules a template must keep

- **`role.md` is generic.** No person, company, vendor, place or language. `assertRoleIsGeneric`
  (`packages/agent-kit/src/persona/lint.ts`) refuses a role that names one. The repository carries
  only generic rules; an installation's own words are checked against a deny-list kept outside the
  repository, via `LARES_DENYLIST_FILE` (a text file with one case-insensitive, whole-word regular
  expression per line). With it unset, only the generic rules run.
- **Tools named in `role.md` must be granted.** The role text may call a tool by name (the
  chief of staff's calls `read_url`). Drop the grant behind one and the assemble fails
  (`assertRoleToolsAreDeployed`), before anything is written. Each template's README has a
  "Which grants the role text assumes by tool name" table. Tool names, unlike vendor names, are
  exempt from the generic lint (`TOOL_NAMES` / `TOOL_NAME_PATTERNS` in
  `packages/agent-kit/src/persona/vocabulary.ts`).
- **A skill never widens a grant.** `assertSkillsWithinGrants` (`packages/agent-kit/src/manifest.ts`)
  fails with, for example: `agent.json: skill "commercial" requires "twenty" at "write", but the
  grant is only "read" — a skill can never widen access`. The same check runs when a definition is
  saved and again when a session starts.
- **`egress.sealed` stays `true`, and every `write-with-confirm` grant ships `autonomy: "gated"`**
  (both checked by `tests/templates.test.ts`). Unsealing egress or making a grant autonomous is a
  choice an installation makes later on its own agent, never a template default.
- **`autonomy` is not a gate on every write.** It only bites on a tool that carries an approval,
  and a plain `write` grant cannot carry one (`assertClassMatchesScope`). A plain-write grant writes
  with no card by construction; the tests assert the plain-write grants as an exact list per
  template, so adding a cardless write is a red test and a decision. Each template's README lists
  them under "Writes without a card".
- **`framework_tools`** names eve's own built-in tools the agent keeps; today only `web_search` is a
  valid entry (no template declares it).

### The neutral default persona

Each role also ships as a role image (`services/chief-of-staff`, `services/creative`) with a
neutral default persona, committed as `agent/persona.md`, so tests run against something with no
installation in it. It is assembled from three inputs, and CI checks that the committed file matches
them:

```sh
# from services/<role>
pnpm run assemble          # rewrite agent/persona.md from role.md + agent/voice.md + agent.json
pnpm run assemble:check    # compare in memory, byte for byte; exits 1 and writes nothing if stale
```

Run `assemble` after any edit to the role text, the role's `agent/voice.md` or its `agent.json`,
and commit the result. The role image's Dockerfile runs `assemble:check` before `eve build`, never
`assemble`, so a commit that edited an input and forgot to regenerate fails the build instead of
shipping stale instructions. The "where I run" section of the persona is generated from the
declaration, never hand-written.

`agent/voice.md` in the role service is the neutral voice that ships with the engine. An
installation writes its own voice in the console, as part of its definition.

### Reading what actually shipped

The generated section lists tool names found under the role's `agent/tools/*.ts` and
`agent/extensions/agent-kit/tools/*.ts` (`deployedToolsFor`,
`packages/agent-kit/src/persona/deployed-tools.ts`). That is the cheap, filesystem-only view; a file
can exist there and still not ship (a `disableTool()` sentinel, a scope check `eve build` applies).
The authoritative answer is what `eve build` compiled:

```sh
cd services/<role>
node -e 'console.log(require("./.output/.eve/compile/compiled-agent-manifest.json").tools.map(t=>t.name).sort().join(", "))'
```

Each role service's `tests/agent-declaration.test.ts` checks the persona against that file.
`.output/` is a build artifact (gitignored), so those checks are skipped, not failed, when it is
missing; run `pnpm run build` before `pnpm test` in the service directory for them to actually run.
