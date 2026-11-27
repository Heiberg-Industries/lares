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
- Values: `owner` (only the designated owner), `admin` (the owner, or a person the owner made an admin), `member` (any signed-in member), `public` (no session; the row says in `reason` what protects it instead), `none` (nothing to act on), `unknown` (could not be read).
- `ownerExtras`: someone below the owner passes the guard, but part of it is owner-only (a section of the page, or one branch of the action). `adminExtras`: the same for a part that needs an admin.
- `guards`: the guards of `lib/auth.ts` it goes through: `requirePage`, `requireAction`, `actingAddress`, `mayUse`, or a session lookup that is checked.
- `actions`, `routes`: what a page reaches. `usedBy`: which pages reach an action or route.
- `source`: `derived` (read from the code), `override` (resolved by `overrides.json`), `unknown`.
- `changesState` (routes): any method other than GET, plus the GET handlers named in `overrides.json`.

## How the guard is derived

The console has one function that decides who may use what: `mayUse(person, level)` in `lib/auth.ts`, with three levels: `owner`, `admin`, `member`. Pages, actions and routes reach it through four guards, and each call writes its level out as a word: `requirePage("admin")`, `requireAction("owner")`, `actingAddress("admin")`, `mayUse(person, "owner")`.

The generator follows each page, action and route to those calls and reads the word. A guard counts only if it really refuses: `requirePage` and `requireAction` throw or redirect by themselves; `actingAddress` returns nothing for a refused person, so its result has to be checked and end the function; `mayUse` counts where a "no" ends the function. A level that is not written out as a plain word cannot be read and counts as no guard. A call whose failure is swallowed (`.catch`, `Promise.allSettled`) does not count. The strictest guard found is the row's level. If none is found the row is `unknown`.

The generator's table of guards (`AUTH_GUARDS` in `generate.ts`) says how each one refuses. The test runs the real `lib/auth.ts` against that table for all three levels, and fails if `lib/auth.ts` exports a function the table does not know.

"Reaches" means imports: a page reaches an action when the page, or a component or library file it imports, imports that action. It does not mean a person can click it. Route use is found from the path strings in those files.

## What it cannot see

- Checks made outside the console. For example the keeper decides, per agent, whether a member may edit it. The inventory says `member` for those rows; the real answer is narrower.
- Controls that are hidden or shown by client-side code. A button the page hides from a non-owner is not a guard.
- A guard written in a shape the generator does not recognise. That shows up as `unknown`, never as a silent `owner`.
- The gate in `middleware.ts` (see the next section).

## How actions are found

Every file under `app`, `components` and `lib` that starts with `"use server"` is read. Each exported function is a row. An export that is not a plain function (a wrapped call, a re-export, a default export, a destructured name) is a row marked `unknown`, because the browser can still call it. A `"use server"` inside a function body is a row `inline:<file>#<number>`, also `unknown` until resolved. The test counts every `"use server"` in those three folders with a separate scanner and fails if the count differs from what the generator listed (`useServerDirectives` in the inventory).

## Not covered: the gate in `middleware.ts`

`middleware.ts` runs before every page and route, and the inventory does not list it as rows. The generator reads functions and their guards; the gate is a chain of path and method checks that it cannot turn into truthful per-page rows. When a page or route is replaced, whoever does it must check these by hand:

- Any request that is not a read (not GET, HEAD or OPTIONS) must come from the console's own address, or it is refused. The three exceptions below are let through before this check.
- Slack and Telegram event posts (`/api/doors/<name>/slack/events` and `/telegram/events`) are let through by path and method alone, for the platforms to call. The console does not check who sent them; it passes the platform's signature on to be checked further in.
- The two money-gateway calls (`/v1/gateway-budget/admit` and `/settle`) are let through when the method is POST, the path matches exactly and there is no query string, for machine callers. The signature is passed on and checked further in.
- `/api/private-metadata/credential` is let through when the method is POST, the path matches exactly and there is no query string, for a server to call. The route itself checks the bearer token.
- `/api/auth/login`, `/callback` and `/logout`, `/sign-in` and `/invite` are reachable without a session cookie.
- Every other path with no well-formed session cookie is sent to sign-in. Having a cookie only lets the request through to the page; the page or route still has to check who the person is, which is what the rows list.
- Signed-in pages are sent with a header telling the browser not to keep them.

Removing or loosening any of these is a change to who can reach the console, and is its own pull request, decided by the owner.

## When a row is `unknown`

The test fails. A person reads the code, and either changes it so the guard can be read, or adds a line to `overrides.json` under `guards` with the level and a one-line reason. The test also fails on an override that is no longer needed, so the table stays small.

## Who may use what

The owner decided three levels. The lists are written out at the top of `action-inventory.test.ts`, and the test fails when the code and the lists disagree in either direction:

- `MEMBER_PAGES`: Chat, Your accounts, Your membership. A member is exactly as before the admin level existed.
- `ADMIN_PAGES`: the shared pages an admin may also open.
- `OWNER_PAGES`: Members, Backups, General.
- `MEMBER_ACTIONS`: the actions any member may call. Nothing that was owner-only may appear here.
- `OWNER_ACTIONS`: the actions that stay with the owner, each with its reason. Many sit on a page an admin may open.
- Every other action is `admin`.
- `ROUTE_LEVELS`: every route that uses a session, with its level.

The default is owner: a new page, action or route that nobody placed in a list fails the test. Opening something to an admin or a member is a line added there on purpose. `publicByDesign` in `overrides.json` names the pages a signed-out person must reach (sign-in, invitation).

`tests/console-levels.test.tsx` checks the same thing by running the code: it calls every page, action and route in the inventory as the owner, an admin, a member and a person with an unknown role, and fails if anyone below the level gets in or anything is read for them.

## Change-over rule for the redesign

While the console is redesigned, an old page keeps rendering until its replacement has every action on the list:

1. A restyle pull request names the inventory rows it moves: the page row, and every action and route row that page lists under `actions` and `routes`.
2. The old page is removed only in a pull request where the new page lists every one of those actions and routes, or where the pull request says, row by row, which one is being retired on purpose and why.
3. `action-inventory.json` is regenerated in the same pull request, so the diff shows exactly which rows moved, appeared or went. An action that vanishes from the list without being named in the pull request is a lost control.
4. Who may see or act on a row must not become more open in a restyle. A change to that is its own pull request, decided by the owner.
