# Lares

Lares is a self-hosted fleet of named AI agents that runs the operating overhead of a small
business: the inbox, the calendar, deadlines and renewals, meeting follow-ups, the daily brief.
It runs on one server you control, talks to models through a gateway on that server, and keeps
what it learns as plain Markdown in Git.

> **Alpha.** Lares is experimental and under active development. There is no tagged release
> yet, only release candidates. Expect breaking changes, rough edges and manual steps. Try it on
> a disposable server before you connect real accounts.

## What it does today

An installation runs one or more agents. Each agent is a definition, not a build: a name, a
role, a voice, the doors it answers on and exactly what it may touch. The engine ships two
neutral role templates:

- **Chief of staff.** Reads and drafts mail, manages the calendar, looks people up across the
  CRM, mail and meetings, keeps a deadline calendar (renewals included), drafts meeting
  follow-ups, and sends a morning and an evening brief.
- **Creative.** Ideation on a brief, grounded in the business's own knowledge, returned as a
  spread of options rather than one answer.

Across all of them:

- **Approvals before anything leaves.** Sending mail or changing something outside the server
  goes through an approval card the owner taps.
- **One gate for unprompted messages.** Briefs and nudges run on named slots, respect quiet
  hours on the owner's clock, stay silent when there is nothing to say, and keep a record of
  what was sent and why.
- **You choose where each message goes.** For every kind of message an agent starts itself, you
  rank the doors to try (web chat, Slack, Telegram). If none is connected the message lands in
  web chat, which every agent has, so nothing is dropped, and the record says why.
- **A web console.** Sign in with Google to chat with agents, read what they left for you in the
  web chat inbox, decide what they are waiting on, create and edit them, grant or revoke what they
  may touch, connect integrations, and check backups and model status. A
  [tour of the console](docs/how-to/using-the-console.md) is in the docs.
- **Backups you can prove.** Nightly encrypted backups (restic), a monthly restore drill, an
  export of everything, and erasure of one person's data on request.

## How it is built

- **Engine and installation are separate.** This repository is the engine. It holds no personas,
  server names or secrets. An installation is data on your server: agent definitions under
  `/srv/lares/agents/<name>/`, settings and secrets, read at runtime by the engine's images.
  Adding an agent never needs a new image.
- **Keeper.** A small service with a fixed list of actions (save an agent's definition, start or
  stop an agent, apply a credential, connect a door). The console asks the keeper; nothing else
  gets control of Docker.
- **Gateway.** A LiteLLM gateway on the same server. Agents name a purpose, the gateway maps it
  to a model, and each agent has its own key and daily spend cap.
- **Vault.** Memory and knowledge as Markdown in Git, readable in any editor, with named areas an
  agent is or is not granted. Facts with a date or an owner live in Postgres, and each one can be
  exported.
- **Doors.** The ways in: web chat in the console first, then Slack, Telegram and, for the chief
  of staff, e-mail. Each is connected from the agent's page by pasting a credential and pressing
  Connect.
- **Runtime.** Agents run on [eve](https://github.com/vercel/eve), self-hosted. Caddy is the one
  public listener, and outbound traffic from agents goes through an allow-list proxy. Nothing
  phones home.

The reasoning behind each of these is in [`docs/decisions/`](docs/decisions/).

## Requirements

The tested path is:

- a fresh Ubuntu 24.04 x86-64 server with at least 6 GiB of memory and 20 GiB free disk, root
  SSH access by key, and ports 80 and 443 free
- a domain name whose A record points at that server
- an Anthropic API key (a consumer chat subscription does not include API access)
- a Google OAuth client for signing in to the console; connecting Gmail and Calendar needs a
  second client with those scopes
- Docker with Compose v2, Node.js 24 and pnpm 9.15.0 on the server

Images are built in CI and pulled by digest; nothing is built on your server. Other Linux
distributions and macOS are best-effort: expected to work, not tried.

## Installing

There is one **tested path**: a fresh Ubuntu server and one installer that asks four questions
(domain, e-mail, name and model key), tests the key with a real call, and offers to start fresh
or restore from a backup. See
[the tested install path](docs/decisions/0022-the-tested-install-path.md) for what that means.
The installer is `services/box/ops/install.sh`.

The step-by-step guide is [docs/install.md](docs/install.md).

No one has yet installed Lares
from the docs alone without help, and we are working on that next. If you try it, notes on
where you got stuck are the most useful thing you can send.

## Help

Lares is a tested path, not supported software. There is no support agreement or promised
response time. Ask questions in the
[community Slack](https://lares.is/slack)
and file bugs as [GitHub issues](https://github.com/Heiberg-Industries/lares/issues); answers
are best effort. Report security problems privately as described in [SECURITY.md](SECURITY.md),
never in Slack or an issue.

## Developing

Use Node.js 24 and pnpm 9.15.0. From the repository root, run `pnpm install --frozen-lockfile`,
then `pnpm typecheck` and `pnpm test`. The test suites start disposable PostgreSQL containers,
so Docker must be running. See [PR CI coverage and exclusions](docs/pr-ci.md) before reading
too much into a green result. Image builds and runtime probes run only in CI.

Agent
definition backups to Git are optional and off by default; see
[definition backups](docs/runbooks/definition-backups.md).

## Development and attribution

Lares is developed with substantial code contributions generated by Anthropic Claude and OpenAI Codex, under the maintainer's direction. The maintainer is responsible for deciding what is reviewed, merged and released. GitHub's contributor list reflects commit attribution and does not fully describe the tools used to write the code.

## License and contributions

Original Lares code is licensed under the GNU Affero General Public License, version 3 only ([LICENSE](LICENSE)), except where a file states otherwise. Third-party components retain their own licences and notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for how we treat each other, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
