# rc.15.test.20 release notes

**This is a test release, not a finished release.** Do not use it for an installation you depend on. Its record is `releases/2026-11-27-rc.15.test.20.json`. The name deliberately differs from the usual date, `rc.` and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed as built below were built from commit `4ae92750a1b4439531af1c86a8bf07bf3912c5e2`, by the publishing run https://github.com/Heiberg-Industries/lares/actions/runs/45959422240, on 2026-11-27.

The previous release is 2026-11-26-rc.15.test.19.

### Images built and images carried over

A carried-over image keeps the digest of the previous release and the commit that release recorded for it. It is never described as built from this release's commit.

| Image | This release | Built from | Why |
|---|---|---|---|
| console | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | CHANGELOG.md is inside the build context that services/console/Dockerfile copies whole ("COPY . .") (and 314 more) |
| keeper | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | packages/agent-kit/src/approval-reply-sentence.ts is copied into the image by services/keeper/Dockerfile ("COPY packages/ ./packages/") (and 301 more) |
| egress proxy | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | releases/2026-11-26-rc.15.test.19.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds egress-proxy (that workflow's image proofs read release records) |
| firewall helper | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | releases/2026-11-26-rc.15.test.19.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds firewall-helper (that workflow's image proofs read release records) |
| chief-of-staff runtime | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | docs/README.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/chief-of-staff/Dockerfile copies (and 39 more) |
| creative runtime | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | docs/README.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/creative/Dockerfile copies (and 27 more) |
| sync jobs | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | packages/agent-kit/src/approval-reply-sentence.ts is in @lares/agent-kit, which @lares/notion-sync depends on (@lares/notion-sync -> @lares/agent-box -> @lares/agent-kit); services/sync-jobs/Dockerfile installs or builds @lares/notion-sync (and 22 more) |

The database image, the gateway image (the upstream LiteLLM image) and the proxy in front of the console (Caddy) are not built by this project. They are copied unchanged from the 2026-11-26-rc.15.test.19 record; nothing in this run checked whether newer ones exist.

In total 7 images were built and 0 carried over.

## Changes since the previous release

Commit titles from c09263205cb2c450a6fafed76c7806e26df7007a to 4ae92750a1b4439531af1c86a8bf07bf3912c5e2, newest first:

- feat(console): an admin role, set per person on Members (#468)
- test(real-install): the browser steps find the redesigned agent pages (#473)
- docs: describe the console under its new page names (#472)
- fix(console): the agent-limit messages name the General page, not Settings (#471)
- feat(console): give General, Quiet hours and delivery, Backups, Members and Meeting follow-ups the new look (#470)
- fix(agents): name the console's Reviews page in the agents' instructions (#469)
- feat(console): give Deadlines, Saved preferences, the sign-in pages and Chat the new look (#466)
- feat(console): give the connections pages the new look and put Notion's settings on one page (#465)
- feat(console): give the agent pages and Writing style the new look (#467)
- fix(outside-tools): a run-without-asking switch reaches an open conversation, and two checks cannot overwrite each other (#463)
- feat(console): give Overview, Reviews, Permission checks, Alerts and Alert routing the new look (#464)
- Console redesign foundation: design values, page grid, shared parts, new menu and page addresses (#462)
- release: record the rc.15.test.19 test release (#461)

## What changed, and what breaks

- **The console has a new look.** Every page uses one set of colours, type sizes and spacing, in light and dark, laid out on the same grid, with the same cards, rows, badges and messages. On a phone the menu opens from a button. No page does anything it did not do before, except where this list says so.
- **A new menu.** The owner's menu is grouped, and features that are not built yet are greyed and tagged "Coming". Appearance (the light or dark choice), Your membership and Sign out sit at the foot of the menu under the person's name. A member who is not the owner or an admin sees Chat, Your accounts and Your membership.
- **Page addresses changed, and the old ones are gone.** Nothing redirects, so old bookmarks stop working:

  | Old | New |
  | --- | --- |
  | `/waiting` | `/reviews` |
  | `/voice` | `/writing-style` |
  | `/accounts` | `/your-accounts` |
  | `/integrations/outside` | `/outside-tools` |
  | `/meetings` | `/meeting-follow-ups` |
  | `/taste` | `/saved-preferences` |
  | `/activity` | `/permission-checks` |
  | `/signals` | `/alerts` |
  | `/signals/rules` | `/alert-routing` |
  | `/signals/catalogue` | `/alert-routing/catalogue` |
  | `/settings` | `/general` |
  | `/proactivity` | `/quiet-hours-and-delivery` |
  | `/backup` | `/backups` |
  | `/membership` | `/your-membership` |

  Unchanged: Overview (`/`), `/chat`, `/agents`, `/integrations`, `/deadlines`, `/members`, `/sign-in`, `/invite`, and everything under `/api` and `/v1`. The agents' instructions and the console's own messages name the new pages.
- **Every Notion setting is on the Notion page** (Integrations > Notion): the key, the meetings database, the people sync, clipping, the changes waiting for a yes or no, and the frozen documents. The meetings database and the people sync moved there from General; clipping moved there from the Readability worker page.
- **A new level between owner and member: admin.** The owner picks Admin or Member for each person on the Members page, and an invitation can be made as Admin. An admin can open every shared page except Members, Backups and General. An admin can change deadlines, saved preferences, writing style, meeting follow-ups, quiet hours and delivery, alert routing, and where an agent's messages go. An admin can add and check outside connectors and connect one to an agent the owner lets them edit. An admin can see agents but not create, edit or delete them, cannot set up a chat app for one, and cannot answer approvals. Switching a tool to "run without asking" stays with the owner.
- **A "run without asking" switch reaches a conversation that is already open,** at its next step. Before, an open conversation kept the switches it started with until a new conversation began.
- **One database file:** `040_admin_role.sql` adds the admin level. `lares update` applies it. No setting changes.

Model prices were last checked on 18 November 2026.

## Security scan

Scanner: Trivy, no ignore list, run by CI against each final linux/amd64 image immediately before it was published (the number of the version is in the scan step's output). The published digests were not scanned a second time. High and critical findings of the images built in this run:

| Image | Critical | High |
|---|---|---|
| console | 1 | 38 |
| keeper | 3 | 132 |
| egress proxy | 0 | 0 |
| firewall helper | 1 | 34 |
| chief-of-staff runtime | 1 | 110 |
| creative runtime | 1 | 110 |
| sync jobs | 1 | 109 |

A carried-over image was scanned when it was built, for 2026-11-26-rc.15.test.19; this run did not scan it again, and reuse does not clear it.

## What the automated run tested

These jobs of the publishing run finished, in this order of name:

- console / build-push: success
- console / typecheck: success
- keeper-runtime / keeper: success
- keeper-runtime / real-install: success
- keeper-runtime / runtime (chief-of-staff): success
- keeper-runtime / runtime (creative): success
- keeper-runtime / select: success
- plan: success
- record: 
- sync-jobs / build-push: success

The automated run does not replace trying the release on a test server: nothing above says that a live conversation, a live approval or an update with a conversation open works. Add here what a person has tried.
