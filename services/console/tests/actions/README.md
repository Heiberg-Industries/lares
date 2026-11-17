# Console action inventory

A list, generated from the code, of everything a person can open or do in the console: every page, every server action and every route handler, who may see it, who may act on it, and which pages reach which actions. It exists so that the console redesign can prove it kept every control.

| File | What it is |
| --- | --- |
| `generate.ts` | Reads the code and writes the inventory. No database, no running app. |
| `action-inventory.json` | The committed result. Sorted, one entry per line, so a diff shows only rows that changed. |
| `overrides.json` | The small table where a person resolves what the generator cannot read, each entry with a reason. |
| `action-inventory.test.ts` | Fails when the list is out of date, when any row is unknown, or when a page is open to someone it should not be. |

## Using it

Check (this is part of the console tests):

```bash
pnpm -C services/console exec vitest run tests/actions
```

Regenerate after a change to a page, an action or a route on purpose (needs Node 22.18 or later):

```bash
pnpm -C services/console run actions:inventory
```

Then read the diff of `action-inventory.json`. A row that appears, disappears or changes who may act should be something the change meant to do.

## How to read a row

- `kind`: `page`, `layout` (the shell around every page), `action` (a `"use server"` function) or `route` (one row per HTTP method).
- `see`: who may open it. For an action, the most open page that reaches it (`none` if no page does).
- `act`: who may do something. For an action or a route, its own guard. For a page, what the actions it reaches allow, never more than `see` allows.
- Values: `owner` (only the designated owner), `member` (any signed-in member), `public` (no session; the row says in `reason` what protects it instead), `none` (nothing to act on), `unknown` (could not be read).
- `ownerExtras`: a member passes the guard, but part of it is owner-only (a section of the page, or one branch of the action).
- `guards`: the functions in `lib/auth.ts` the guard goes through.
- `actions`, `routes`: what a page reaches. `usedBy`: which pages reach an action or route.
- `source`: `derived` (read from the code), `override` (resolved by `overrides.json`), `unknown`.
- `changesState` (routes): any method other than GET, plus the GET handlers named in `overrides.json`.

## How the guard is derived

The generator follows each page, action and route into the guard calls it makes, down into `lib/auth.ts`. A guard counts only if it really refuses: a helper that throws or redirects, or a result that is checked and then ends the function. A lookup that is never checked does not count, and neither does a call whose failure is swallowed (`.catch`, `Promise.allSettled`). If the strictest guard it finds is the owner check the row is `owner`; if it is only a signed-in-member check the row is `member`. If it finds no guard the row is `unknown`.

"Reaches" means imports: a page reaches an action when the page, or a component or library file it imports, imports that action. It does not mean a person can click it. Route use is found from the path strings in those files.

## What it cannot see

- Checks made outside the console. For example the keeper decides, per agent, whether a member may edit it. The inventory says `member` for those rows; the real answer is narrower.
- Controls that are hidden or shown by client-side code. A button the page hides from a non-owner is not a guard.
- A guard written in a shape the generator does not recognise. That shows up as `unknown`, never as a silent `owner`.

## When a row is `unknown`

The test fails. A person reads the code, and either changes it so the guard can be read, or adds a line to `overrides.json` under `guards` with the level and a one-line reason. The test also fails on an override that is no longer needed, so the table stays small.

## Who may reach a page

The owner decided: every page except chat and membership stays owner-only for now. The test fails when any other page can be reached by someone who is not the owner. Three short lists are allowed in `overrides.json`, each entry with a reason:

- `publicByDesign`: pages a signed-out person must reach (sign-in, invitation).
- `awaitingOwnerDecision`: pages members can reach today that the owner has not yet ruled on. Each should end up either owner-only or moved into the rule.

## Change-over rule for the redesign

While the console is redesigned, an old page keeps rendering until its replacement has every action on the list:

1. A restyle pull request names the inventory rows it moves: the page row, and every action and route row that page lists under `actions` and `routes`.
2. The old page is removed only in a pull request where the new page lists every one of those actions and routes, or where the pull request says, row by row, which one is being retired on purpose and why.
3. `action-inventory.json` is regenerated in the same pull request, so the diff shows exactly which rows moved, appeared or went. An action that vanishes from the list without being named in the pull request is a lost control.
4. Who may see or act on a row must not become more open in a restyle. A change to that is its own pull request, decided by the owner.
