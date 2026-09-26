# Lares installer + onboarding wizard — design (ORB-266)

**Status:** APPROVED in brainstorm (the owner, 2026-09-14), section by section. Plan 1 of 3:
`docs/superpowers/plans/2026-09-14-lares-installer-plan-1-box-and-keeper.md` (Plans 2 and 3 outlined at its end).
**Parent:** `2026-08-17-shared-agent-stack-design.md`, sub-projects 3 (the box installer) and 4 (the
wizard half of the admin UI).
**Rulings this starts from:** `plans/2026-09-11-lares-launch-sessions.md` § Parity rulings and § Second
sweep (public console posture, folded into ORB-266).
**Depends on:** the repo split (`2026-09-11-lares-repo-split-design.md`, ORB-262). The installer installs
the Lares engine repository.
**Unblocks:** ORB-197 (golden path, steps 2 and 4), ORB-283 (onboarding agent), ORB-287 (fleet operations).
**Paths** are in the `lares` layout (after the split: `services/box`, `services/chief-of-staff`, `services/travel`,
`services/keeper`, …) — that is where this is built; the split's Task 14 copies engine specs into `lares/docs`.
Installation-specific files remain outside the engine. **Execution waits for ORB-269** (an installer installs a release).
**Amended 2026-09-15:** ORB-269 executes first and builds the keeper core (settings, guarded migrate, release
manifest, secrets, action sockets, the `lares` command) plus the update in *overlay mode* on the owner's box
(`2026-09-14-lares-releases-and-update-design.md`, Part 3a). This spec's keeper reuses that core and adds
*rendered mode* — the compose file drawn from settings — for ready-made installations.

## The finding, up front

Today's box was assembled by hand from runbooks: an encrypted disk, Tailscale, a firewall, an egress seal,
`brain-init-remote.sh`, 36 SQL files applied one by one, secret files written with `chmod`, and six
services that live on a second server (ops-1). None of it is scripted, and almost every setting is an
environment variable in a compose file — changing one means editing a file on the server and restarting
a container.

That second fact is the real design problem. The console is deliberately unprivileged (read-only root
filesystem, no Docker access), so the ticket's acceptance line — *every setting the wizard writes is also
visible and editable on the console* — needs a mechanism that does not exist. This spec's answer is a
small privileged helper with a fixed list of actions: **the keeper**.

## Decisions (2026-09-14)

| Question | Decision | Why |
| --- | --- | --- |
| Who runs install + wizard at launch | **domus builders run both themselves; the owner runs both for villa/familia** (with the client on a call for their own Google/Slack admin clicks) | The wizard may assume a technical person is present. Plain and clear, not screenshot-level hand-holding. |
| Disk encryption | **Optional "hardened setup" recipe, run before install.** The installer works on any fresh Ubuntu server and reports honestly whether the disk is encrypted | A script on an installed server cannot encrypt the root disk (that needs Hetzner rescue mode), and a manual unlock after every host reboot is an outage. the owner uses the recipe for villa/familia. |
| Tailscale | **Optional.** Baseline is key-only SSH on the public port + 80/443; Tailscale, when given a key, lets the owner close public SSH and enables the "tailnet only" switch | Consistent with rejecting Cloudflare Tunnel as a required extra US account. the owner keeps Tailscale on managed boxes. |
| First run | **Terminal asks domain + owner email, prints a one-time setup link; wizard step 1 = Google sign-in, which kills the link** | Everything after step 1 sits behind normal sign-in, so the wizard can be left and resumed; no powerful link lives on the public internet for longer than one step. |
| How the console changes server-side settings | **Approach A: the keeper** — a privileged helper with a fixed action list and an audit log. Settings services already read from the database stay live there | B (every setting read live from the DB) is a rewrite that still needs restarts for secrets and doors; C (console writes intent, owner runs `lares apply`) is not console-first. The keeper is also where the update command (ORB-269) lands. |
| Where a new installation's agents are built | **Ready-made role images published by each release; name, gender and voice are settings read every turn** | The box never builds (8 GB OOM history) and a fresh install has no overlay repo or CI. eve's dynamic instructions (`defineDynamic`, as Saga's clock instruction already uses) make runtime identity possible. Custom agents or skills = graduate to an overlay repo, exactly like the owner's. |
| Default agents | **Named after their role ("Chief of Staff", "Travel"), neutral role voice, no shipped personalities** | Every personality is one the owner writes. Nothing from Saga, Marcel or Calliope ships. |
| Which roles ship ready-made | **Chief of Staff and Travel.** Creative is dropped from the launch set (the template stays in the engine; the owner's Calliope is unaffected). A **health / training coach** role joins the launch set when its spec is ready | Launch with the two roles that carry the pitch; the coach is the owner's next role (spec in progress, 2026-09-14). |
| Shared services (gateway, spine, web-read) | **Each is "on this box" (default) or "an address you already run"** | the owner runs one gateway and one spine for the whole portfolio; his installation points at them. A stranger gets everything on one box. |
| Personal Gmail | **Google Workspace is a prerequisite for the Gmail/Calendar connection at launch.** Personal Google accounts may still sign in to the console | Unverified apps on personal accounts are believed to lose Gmail access every 7 days (probe in the plan, Task 1). Building a weekly-reconnect flow, or paying for Google's verification, is not a launch item. |
| Default spend caps (on-box gateway) | **$5/day per agent key, $2/day per background-job key, $10/day installation ceiling**; alerts at 85 % and 95 %; owner edits all three in the console | The 2026-08-14/15 $250 loop is exactly the day-one risk; low defaults make a runaway cheap. |

## Part 1 — The shape

Three parts, one release.

1. **The install command (historical proposal, not a published endpoint).** The owner chose `lares.is` on 2026-09-25; `lares.sh` was not purchased. Installer distribution must be confirmed separately before documenting a runnable command. The proposed target is root on a fresh Ubuntu 24.04
   server. Idempotent: a second run repairs what is missing and changes nothing else.
2. **The keeper.** The privileged helper (Part 3). The installer's work after the bootstrap is the
   keeper's first run. A small host command `lares` (`lares status`, `lares setup-link`, `lares backup`,
   `lares logs <service>`, `lares reset-allowlist`) talks to the same keeper, so a builder has a terminal
   route to everything the console does.
3. **The wizard.** A console area, ten steps (Part 4). Every step ends in a live check. Leave and resume
   at will. Everything it writes reappears under the console's Settings.

### What runs on one box

| Service | Placement on a Lares box |
| --- | --- |
| Postgres (pgvector) | As today. Adds a separate `litellm` database when the gateway is on the box. |
| Agents | Ready-made role images (Part 5) — one Chief of Staff (named in wizard step 6); Travel added from the console. |
| Console | As today, plus the wizard and Settings areas. Public behind Caddy (Part 6). |
| Sync jobs | notion-sync ON only if Notion is the top layer (step 4); atlas-sync OFF by default. |
| **Model gateway (LiteLLM)** | **Setting `gateway: box | external`.** `box`: own container, data in the `litellm` database (backed up with everything else), admin UI never routed publicly; the keeper holds the master key and manages credentials and virtual keys through LiteLLM's admin API. `external`: no container; the installation stores the gateway's base URL and one virtual key per agent/job, created on that gateway by its owner; caps live there and the console says "managed on your gateway". An external gateway must be LiteLLM (or serve the same `/v1/messages` router route with purpose aliases), because that is the route the agents use (ORB-225). |
| **Purpose aliases** | An installation setting, not a code default. Fresh install: `lares-brain`, `lares-gate`, `lares-writer`. the owner's installation: `heiberg-brain`, `heiberg-gate`, `heiberg-writer`. On an on-box gateway the wizard maps each alias to a model from a table shipped per release (verified by a live probe each release — never model ids from memory). |
| **Signal spine** | **Setting `signals: box | external`.** `box`: the spine runs on the box and routes to the owner's Slack or Telegram. It needs Inngest today (`services/signal-spine/server.ts`); the plan's Task 1 measures self-hosted Inngest's memory on the box, and if it exceeds the budget the spine gains a direct in-process mode instead. `external`: URL + ingest/read/admin tokens of a spine the owner already runs — the owner's installation points at `signal.example.org`, which keeps serving Zero7, Orakel and the rest unchanged. |
| **Web-read (readability)** | **Setting `web_read: box | external`.** `box`: own container, the one service allowed to fetch arbitrary pages, blocked from the box's internal network (SSRF guard). `external`: URL + token. |
| Door ingress | **Caddy on the box** (Part 6). The ops-1 slack-relay is not part of a Lares install. |
| Backups | restic to the owner's own storage (step 8). ORB-187 builds the backup engine; this spec builds the wizard gate and the keeper actions that drive it. |
| Monitoring | No Uptime Kuma. The box checks itself (disk, backups, input freshness) and alerts through the spine. For "the box itself died" the wizard offers an optional healthchecks.io ping (EU-run); without one the console says plainly that nobody will notice if the box dies. |
| Tracing | Langfuse optional; the OTEL exporter already no-ops without keys ("running WITHOUT trace export"). |

**Targets.** Linux (Hetzner CX class) in this plan. The minimum server size is set from a measurement
(plan Task 1: the full stack + one agent, peak RSS), never guessed. **Mac** is a later phase with known
differences recorded here so it is not re-discovered: no public address (tailnet or localhost only), a
weaker egress seal inside Docker Desktop's VM (squid only, no host nft), schedules that stop while the
laptop sleeps.

## Part 2 — The install command

Run as root on a fresh Ubuntu 24.04 server:

1. **Pre-flight.** OS version, memory and disk against the measured minimum, ports 80/443 free, not
   already a Lares box (a re-run switches to repair mode). A failed check stops with one plain sentence
   and the fix.
2. **Base.** Docker from its official apt repository; unattended security updates on; the `lares` user
   and group (uid/gid 10001, the uid every service already runs as); `/srv/lares/` for data,
   `/etc/lares/secrets/` for secrets (`root:lares 440`).
3. **Images.** Pulled by digest from the release manifest, never built. **Private period:** until the
   public flip (ORB-272) the images are private; the command accepts a registry token
   (`LARES_REGISTRY_TOKEN`) for the golden path runs and the owner's managed boxes.
4. **Keeper starts** and generates every internal secret: database password, token encryption key,
   gateway master and salt keys, console session secret, eve route passwords, webhook secrets.
5. **Two questions:** domain, owner email. The keeper resolves the domain itself and compares it with
   the box's public addresses (A and AAAA). On a mismatch it prints the exact record to add and waits. It
   never asks Caddy for a certificate before DNS is right — Let's Encrypt locks a domain out after
   repeated failures.
6. **Database.** Created and every schema file applied in order — the box's hand-applied SQL ends here.
   The same guarded migrate is what the update command (ORB-269) later reuses.
7. **Knowledge stores, empty, in the shape the tools expect.** The vault as a bare repo + working clone
   with its post-receive hook (`services/box/ops/brain-init-remote.sh`, generalised): `wiki/`, `wiki/people/`,
   `wiki/companies/`, `raw/`, `_inbox/`, `_meta/`, `_meta/conversations/`, `_meta/dream/`, and the
   `.gitignore` for `.locks/`. Atlas the same way. Each root gets a short README note saying what goes
   where. (The plan confirms the folder list by reading the tools, not this paragraph.)
8. **Firewall and egress seal.** Inbound: 22 (key-only), 80, 443, plus 2222 when the encrypted-disk
   recipe was used, plus Tailscale when joined. Outbound: agents reach only the internal network and
   the squid allow-list; the allow-list is rendered from what is enabled (Part 3).
9. **Caddy** fetches the certificate, the stack comes up, and the command prints the **setup link**
   (single use, 24 h, `/setup/<token>`). `lares setup-link` issues a new one, but only until Google
   sign-in is configured.

**Restore mode.** `… | bash -s -- --restore` on a fresh server asks for the backup storage and the
recovery kit, restores the database and the stores, re-applies settings, and brings the house back
under the same domain. What the kit's keys unlock comes back by itself: Google refresh tokens
(token encryption key) and, on an on-box gateway, provider credentials (gateway salt key). Every other
secret the backup does not hold, the restore asks for again, listed from the secrets manifest; whether
secret files ride the (client-side encrypted) snapshot instead is ORB-187's call. This is the answer to
"my server died", and ORB-197's rehearsed restore runs it.

**The hardened setup recipe** (docs, not code): Hetzner rescue mode → full-disk LUKS + dropbear unlock on
2222 → then the install command. Installation-specific setup remains in private operator documentation.

## Part 3 — The keeper and where settings live

- **Settings live in the database**, typed, one audit row per change (who, when, old → new). The console
  reads them directly; agents read the per-turn ones directly (name, gender, voice, time zone,
  language, the connected-integrations list). They are backed up with the database.
- **Secrets live as files** in `/etc/lares/secrets/`, mounted as Docker secrets exactly as today. Only
  the keeper writes them. The console never shows a secret back after submit: it shows "set, last
  changed 14 Sep" (the ORB-43 rule — never claim to see a credential you do not hold).
- **The keeper renders the server's files from settings + the release's templates:** the compose file,
  the Caddyfile, the squid allow-list and the nft sets. Enabling an integration adds the web addresses
  its adapter declares (the contributed-adapter checklist's egress line); disabling removes them.
  Then it restarts only the affected services.
- **Fixed action list (v1):**

  | Action | Does |
  | --- | --- |
  | `secret.set(name, value)` | writes one file from a fixed name list; rejects any other name |
  | `apply(services[])` | re-renders, `compose up -d` the named services, prunes old images keeping one rollback |
  | `restart(service)` | one named service |
  | `dns.check`, `cert.status` | the Part 2 step 3 check; Caddy's certificate state |
  | `status` | services, disk, memory, disk encryption yes/no, versions, last backup |
  | `gateway.provider_add`, `gateway.key_create`, `gateway.key_rotate`, `gateway.cap_set` | on-box gateway only |
  | `telegram.webhook_set(agent)` | registers the door with its generated secret |
  | `vault.key_add(pubkey)` | lets a laptop's Obsidian reach the vault through the git-only SSH user |
  | `backup.now`, `backup.test_restore` | drive ORB-187's engine |
  | `setup_link.issue`, `allowlist.reset` | the latter only from the host `lares` command — the break-glass route when the owner is locked out |

  The update command (ORB-269) adds `update(release)`; this spec reserves the name only.
- **Reach:** a Unix socket mounted into the console container only. Anything not on the list is refused
  and logged; every call writes an audit row. No shell, no arbitrary compose edits.
- **Housekeeping on the box:** disk guard, backup verify and input freshness from `services/box/ops/`,
  re-pointed from Kuma to the spine; old images pruned on every `apply` (the unpruned-image disk fill).
  Automatic reboots for kernel updates only on unencrypted boxes.

## Part 4 — The wizard

| # | Step | Writes | Live check |
| --- | --- | --- | --- |
| 1 | **Sign-in** — guided Google Cloud project + OAuth client; paste id and secret | login client secret, allow-list = owner email | owner signs in with Google; the setup link dies |
| 2 | **Models** — `box`: pick providers, paste keys; `external`: gateway URL + per-agent keys. Says plainly: *API keys only; a ChatGPT or Claude subscription will not work* | provider credentials, alias → model map, agent/job virtual keys with the default caps | one real call per provider through the gateway |
| 3 | **Your house** — organisation name, your name, time zone (from the browser), brief language (ORB-267) | `orgs` row, owner `users` row, installation settings | — |
| 4 | **Knowledge** — what sits on top of the vault: nothing / Obsidian (shows the `git clone` command, adds the laptop's key) / Notion (paste token, share pages, turns notion-sync on) | top-layer setting, vault key or Notion token | Notion: the shared databases are listed |
| 5 | **Connect Google** — Gmail + Calendar in the same Google project, through the console's existing Connections flow (ORB-43). Google Workspace required | encrypted refresh token | one calendar event and one mail header read |
| 6 | **First agent** — Chief of Staff; rename (optional), gender (female / male / agent), voice (optional free text with guidance on what a voice description is — no shipped personalities) | agent settings | the agent answers "hello" inside the wizard (eve's HTTP session route) |
| 7 | **Doors** — Slack (a pre-filled "create app from manifest" link carrying the request URLs) and/or Telegram (BotFather steps). The owner claims a door by sending a **one-time code** shown in the wizard, so a stranger who finds the bot first cannot become its owner | door secrets, the owner's Slack/Telegram id as a `user_aliases` row and in the door allow-list | the agent replies in the door |
| 8 | **Backup — required to finish.** Hetzner Storage Box (append-only where the target supports it) or any S3-compatible storage (Scaleway, Hetzner Object Storage). Then the **recovery kit**: the backup password, the token encryption key and the gateway salt key — without which a restore is useless. The owner types back the last characters to prove it is saved | backup target + credentials | first snapshot taken, listed back, one file restored and compared |
| 9 | **Watchers** — where alerts go; optional healthchecks.io URL; optional Langfuse keys | spine route, heartbeat URL | a test alert arrives |
| 10 | **Done** — "send me a brief now" | schedules switched on | the brief arrives in the owner's door |

- **Schedules start with the first door.** The brief and every other schedule stay off until a door is
  claimed, so nothing runs with nowhere to deliver. Brief times stay the engine defaults until ORB-268.
- **One text, two readers.** Each step's guidance is the docs page for that step (ORB-259's `/docs`),
  written in the same change, so the wizard and the docs never drift.
- **The unverified Google risk, stated:** a Workspace installation marks its OAuth app "Internal", which
  is believed to avoid both Google's verification and the 7-day refresh-token expiry that applies to
  unverified "External" apps in testing. Plan Task 1 probes both account types live before any wizard
  copy is written; the result can only widen what launch supports, never narrow it.

## Part 5 — Ready-made agents

> **Superseded in part by ADR-0015 (2026-09-15).** "Ready-made role images with name and voice as settings" is
> now the first step of a larger rule: an agent is a **definition** (name, description, duties, personality,
> language, model, grants, autonomy) resolved at runtime on a role image used as a tool pool. The wizard's step 6
> ("first agent") creates a definition — any name and duties, not only a role's stock agent — with the same
> screen as ORB-278's agent builder. Runtime identity, the connected-integrations instruction and the
> unconnected-tool sweep below still hold.

- **Each release publishes a runnable image per launch role** (`lares-chief-of-staff-ready`,
  `lares-travel-ready`) built from the role service's neutral default `agent.json` (all template grants)
  and neutral `voice.md` (split spec, Part 3). Nothing is built on the box. No `-creative-ready` image
  at launch; the creative role service and template stay in the engine for overlay builds.
- **Adding a role is one more image, not a redesign.** The health / training coach role joins the
  ready-made set when its spec lands — with one condition from the inventory spec's rule that role
  templates are *extracted, not invented*: the coach runs as a real agent on the owner's installation first,
  and its template is extracted from that, or it ships explicitly marked as a first-cut role.
- **Identity is read every turn** by one dynamic instruction in the role service: name, gender, pronouns
  and the owner's voice text from the agent's settings; empty voice falls back to the neutral role
  voice. It is active only in the `-ready` build, so an overlay-built agent — Saga — assembles
  byte-identically to today (the split's gate still holds).
- **A second dynamic instruction lists what is connected** and what is not, every turn, so the agent
  neither denies a capability it has (the Wave-1 bug in `services/chief-of-staff/tests/instructions.test.ts`) nor claims one it
  cannot use.
- **Unconnected tools say so.** Every tool whose integration has no credential answers *"X isn't
  connected — set it up in the console"*, never "nothing found" and never a raw error — the Orakel
  rule ("not subscribed" ≠ "nothing found") applied to every adapter. A test runs each shipped tool with
  no credential and asserts that sentence shape. This is a sweep across the tools in `lares`, not a
  per-tool afterthought.
- **Graduating.** Custom grants, skills or a fourth agent mean an overlay repo with its own CI, exactly
  the owner's shape. The console says where that line is. The agent builder (ORB-278) builds on the
  ready-made mechanism, not around it.

## Part 6 — The public front door

- **One listener**, Caddy on 443 with automatic certificates for the owner's domain. Exact path
  allow-list: the console, `/setup/<token>`, and one webhook path per agent per door —
  `/doors/<agent>/slack` and `/doors/<agent>/telegram`, rewritten to that agent's
  `/eve/v1/slack|telegram`. Slack's signature covers the body, not the path, so the rewrite is safe;
  signature checks stay inside the agent (ADR-0011's rule, kept). Everything else is 404: eve's session
  and workflow routes, the gateway UI, the spine's admin routes. One domain replaces the relay's
  one-hostname-per-door.
- **Login:** Google sign-in + email allow-list with the installation's own OAuth client (as today); rate
  limit on the login path; strict security headers; secure session cookies; a login audit row. The
  middleware covers every route except login and setup — a test enumerates every route under `app/` and
  fails if one is reachable signed-out.
- **"Tailnet only" switch:** closes the public console and public SSH; the door webhook paths stay
  public because Slack and Telegram must reach them. Requires Tailscale.
- **Obsidian** reaches the vault through a git-only SSH user (`git-shell`, the vault repo and nothing
  else) — over the public port by default, over the tailnet once "tailnet only" is on.
- Cloudflare Tunnel and Tailscale Funnel are documented options, never the default.
- **Licence:** the console footer links to the exact source of the running release (AGPL-3.0's
  network-use clause).

## Part 7 — What it depends on

| Before | Why |
| --- | --- |
| ORB-262 repo split | the installer installs `lares` |
| ORB-267 brief language + time zone as settings | step 3 writes them; today they are hard-coded (`brief-content.ts`, `Europe/Oslo`) |
| ORB-187 backup engine | step 8 and the restore mode drive it |
| ORB-250, the items that break a stranger's install | `CANONICAL_USER_ID = "bendik"` (`services/chief-of-staff/lib/identity-client.ts`), `U_BENDIK`/`U_bendik` principal ids, `heiberg-brain` as a code default, `@example.com` git authors, `signal.example.org` / `gateway.example.com` in code |
| ORB-188 caps | the $5/$2/$10 defaults are LiteLLM key budgets + `litellm_settings.max_budget`; ORB-188's per-member caps build on the same keys |

- **`EVE_` → `LARES_` rename rides this work** (ruling 2026-09-04): code and the owner's overlay compose
  change in one commit, no compatibility layer.
- **Gate for the first invite, not for this plan:** the update command (ORB-269) must exist before
  anyone outside installs — members cannot install what they cannot update.

## Part 8 — What proves it worked

1. **ORB-197 steps 2 and 4 on a throwaway Hetzner box, from the docs alone**, ending in step 10's brief.
   This is the acceptance bar; a green suite is not.
2. A second run of the install command changes nothing (a diff of rendered files and container digests).
3. The restore mode brings a destroyed throwaway box back from its recovery kit.
4. Keeper tests: every action on the list works; every other request, unknown secret name and path
   traversal is refused and logged.
5. The route-coverage test (Part 6) and the unconnected-tool test (Part 5).
6. **Live probes committed as `tests/live/*.live.mts`** (the third-party API rule): Google OAuth on a
   Workspace and a personal account, Slack's create-from-manifest link, Telegram `setWebhook`, LiteLLM's
   credential and key calls, the DNS check. Each covers both directions — the case it must accept and
   the case it must refuse.
7. the owner's Saga stays byte-identical (persona hash + `/eve/v1/info` tool list) through every change here.

## Part 9 — the owner's installation

It keeps running as an overlay install throughout. **Amended 2026-09-14 (the owner: build locally as long as
possible, then reuse this box; some downtime is acceptable):** Plan 1 proves the install in a fresh VM on
the Mac (local mode: Caddy signs its own certificate, no DNS check), then installs the keeper on
lares-agent-1 **beside the fleet** — own compose project, network and database, with gateway, spine and
web-read external — as the internet-facing proof. One rule this surfaced: the keeper only ever removes
images it pulled itself, by exact ref on a release change, never by name pattern. **The last phase then
moves the fleet itself onto the keeper and settings model** — `gateway: external`, `signals: external`, `web_read: external`, backups kept on the
Storage Box — only after the golden path passes, so his box and a member's end up the same shape. That
phase touches the live box and follows the session coordination rules in `docs/HANDOFF.md` (one box
writer).

## Plan phases

1. **Measure:** peak memory of the full stack + one agent, self-hosted Inngest's cost, the Google
   Workspace/personal probe.
2. **One-box stack + install command + keeper core**, driven from the `lares` terminal command only;
   proven in a local VM and on lares-agent-1 beside the fleet (Part 9).
3. **Front door + sign-in + setup link.**
4. **Wizard steps 2–10**, the ready-made images, the unconnected-tool sweep.
5. **Golden path run** (ORB-197) + restore rehearsal.
6. **the owner's box adopts the layout.**

## Non-goals — next, not never

These follow soon after this phase (the owner, 2026-09-14: "will need to come fast after this phase"):
the Mac target; members and roles (ORB-279); the web chat door (ORB-270); the update command
(ORB-269 — reserved keeper action only); the onboarding agent (ORB-283); the Mac importers in the wizard;
Microsoft 365 (first demand-driven mail/calendar adapter); personal Gmail (decided by the probe).

Not planned: a Twenty CRM on the box (the CRM is an adapter to what the owner already runs); several
installations on one server (struck 2026-08-31).

## Open questions

None left open by design. Three facts are established by measurement in plan phase 1 rather than here:
the minimum server size, whether the on-box spine keeps Inngest, and exactly what Google does to an
unverified app on a personal account.
