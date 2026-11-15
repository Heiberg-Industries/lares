# rc.15.test.1 release notes

**This is a test release, not rc.15.** It moves the agents onto a new version of the framework they
run on. Do not use it for an installation you depend on. Its record is
`releases/2026-11-15-rc.15.test.1.json`. The name deliberately differs from the usual date, `rc.`
and number, so that nobody following the install guide picks it by accident.

## What it is built from

The console, keeper, egress proxy, firewall helper, both agent images and sync jobs were all built
from commit `113dbe94f3143b1a1fa16442f2e03a5536013a55`. The database image, the gateway and the
proxy in front of the console are the same as in rc.14.

Model prices were last checked on 3 November 2026.

## What this test release is

The agents now run on version 1.0 (release candidate 10) of the agent framework, `eve`. That is a
release candidate, not a final 1.0. The move changed how every agent starts and how it takes part in
a conversation, so almost everything below is about a conversation behaving differently, not about a
new feature.

- **Tools.** The framework's own shell, file, web and delegation tools are off: none of them reaches an
  agent. Skills exist only where the agent's definition allows them.
- **Slack and Telegram now get an answer** on a server set up with the installer: their model calls get
  permission from the Keeper, as web chat's already did. A busy store of spending keys is never read as
  "no permission"; starting an agent waits its turn there and says plainly that it is busy.
- **Approval cards.**
  - On Slack and Telegram only the owner can answer an approval card. In web chat the member who
    started the conversation answers its cards.
  - On Slack a person is told when their tap is not accepted.
  - In web chat, a second answer to a card that is already settled is refused.
  - In the reply after an answered card, a new send, calendar change or outside-tool call that would
    need its own card is refused.
- **Long and ended conversations.** A person is told when a conversation has grown too long. Ending a
  conversation from the console works on the new framework, and web chat gives a plain message for an
  ended conversation.
- **Changing a started agent.** A started agent takes an edit from the console. The console says what
  a model change does to a running Slack or Telegram conversation and when a change takes effect. After
  a model change is applied, a Slack or Telegram conversation already running is refused until a new
  one starts.
- **Test morning brief.** A chief of staff's edit page has a button for each connected chat app that
  sends a test morning brief at once. A chief of staff whose message routing was never changed sends
  its briefs and other messages to the first chat app it is connected to, then web chat.
- **The Description field.** The agent edit page and the new-agent page now say, under the Description
  field, "A label for your own reference. Only this page shows it; the agent does not read it."
- **Smaller rules.** An agent refuses two tools with the same name, and saving a definition whose
  outside tool would take the name of a tool the agent already has is refused, with a message that
  names the tool and both places it comes from. A mention in a shared Slack room gets no private read
  tools. Vault file and drop check the person who answered. Scheduled Slack cards go to the
  direct-message channel.
- **Only Anthropic models are on the tested path in this release.** Setting an OpenAI or other model
  by hand is not on it, and chat will be refused.

## Installing and updating

- **This update ends open web-chat conversations**, and so does every later save of a change to a
  running agent; web chat says so.
- **The update stops the Keeper and the agents** while it upgrades the agents' stores. If it fails part
  way, they stay stopped until the same update is run again. The installer and the agent and budget
  commands never run beside an update.
- **An update from the previous release** adds the new workflow tables to each agent's store, and every
  update re-checks those stores' permissions and repairs what is missing. The update script refuses,
  before changing anything, an agent store that has no workflow tables at all.
- **The way this test release is tested is a fresh install followed by a restore.** A backup from the
  previous release restores onto this one; a backup in any other layout is refused with nothing
  changed. A restore is refused beside a leftover store job.
- **Going back** to the previous software needs a restore onto a clean server, not the rollback command.

## A chief of staff's Slack app made earlier needs one more permission

The Slack app the console now sets up for a chief of staff asks for the extra bot permission `im:write`.
The chief of staff needs it for the messages it starts on a schedule (the morning, evening and test
briefs, the weekly summary, deadlines, nudges, meeting follow-ups, outreach replies and track routing),
so that the buttons on its cards reach your direct messages. A creative agent's Slack app does not ask
for it.

A chief of staff's Slack app made before this release does not get the permission by itself. In the
app's settings on Slack, add the bot permission `im:write` under OAuth & Permissions, then install the
app to your workspace again; Slack documents that added permissions only take effect for an existing
install after the app is reinstalled. Without it, Slack is expected to refuse and those messages would
not be sent.

The console's "Send a test brief" result still says only that Slack did not accept it. It does not name
the missing permission.

## Known limits of this test release

- **On Slack it is direct messages only.** The Slack app the console sets up subscribes to direct
  messages (`message.im`) and nothing else, and asks only for the bot permissions `chat:write` and
  `im:history`, plus `im:write` for a chief of staff. It does not subscribe to mentions, so mentioning an
  agent in a shared channel does not reach it.
- **Selective import from an older installation can only preview.**
- The e-mail door is gone: an agent definition that still has one is refused and the agent keeps its
  last valid definition.

## Tested, and not tested

Tested:
- The image checks of the keeper workflow's run prove the role images on the new framework: the model
  guard, the maintenance fence with the workflow tables, the older-backup restore, and a real-install
  check that sends Slack and Telegram messages and test briefs through the Keeper and checks who pays.
  That run's `real-install` job passed on this commit.
- Tests on requests captured offline check that the part of the prompt that stays the same through a
  conversation keeps its cache marker on release candidate 10.
- The Slack permission lists are pinned by a test: a chief of staff's app asks for `chat:write`,
  `im:history` and `im:write`; any other role asks for `chat:write` and `im:history` only.

**Not verified live:**
- The framework is a release candidate (1.0.0-rc.10), not a final 1.0.
- The real-install check uses stand-ins for Slack, Telegram, the model provider and the sign-in
  provider, and has one member, so it cannot tell a charge to the right person from a charge to the
  owner.
- The image checks update between two builds of this same code. An update from the previous release is
  covered by script and database tests, not on real images.
- Nobody has yet seen a real Slack app accept or refuse the direct-message lookup that the `im:write`
  permission is for. The live probe for that lookup was written but has no recorded run.
- The Description field's wording was checked in rendered markup in tests only, not in a running
  console.

## How it was published

One manual run of each image workflow on the same commit, all three finished with success:
- keeper and neutral runtime images (keeper, egress proxy, firewall helper, chief-of-staff runtime and
  creative runtime): run 43730608101;
- console: run 43730632571;
- sync jobs: run 43730653917.

Each of the seven built digests in the record was read from the registry, without signing in, by the
image's tag for this commit, and compared with the digest printed in the run. They matched. The
database, gateway and proxy images are copied unchanged from the rc.14 record. No security scan result
is recorded in these notes.
