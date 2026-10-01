# Runbook: switching a keeper-managed server to the 2026-10-01 release candidate

**What this is.** The order of the switch for a server whose agents are run by the keeper on
older engine images (the existing installation), written down after a local dry rehearsal on
2026-09-30 (LAR-98). The checklist of what has to be done is LAR-74; this page is the *order*, what
success looks like at each step, and the way back.

**What the rehearsal was.** A throwaway database on a laptop, built to look like the server (every
database script through 045, the 037 tables, chief-of-staff script 003, the old conversation-store
layout, three old-style stored definitions, one owner, sign-ins under the old spelling, seven
pending approval cards, made-up unfinished conversations), then the release candidate's real
chief-of-staff image started against it. All data is made up. Nothing touched the server. It is
**not** a substitute for the real rehearsal; the list of what is still open is at the end.

**Which candidate.** Use `releases/2026-10-01-rc.3.json` (keeper and agent images built from
`d95f358`). The rehearsal ran rc.1's chief-of-staff image, before LAR-104, LAR-105 and LAR-106 were
fixed. Where rc.3 behaves differently, the line says so; none of those differences has been seen
with an image yet.

## How to read the evidence marks

Every line below ends with one of three marks. Trust them in this order.

- *[seen locally (made-up data)]* — the rehearsal did it and the result was observed, with the
  real release-candidate image or the real database scripts.
- *[seen via code run, not via image]* — the keeper's own code was run against the rehearsal
  database with Docker replaced by a recorder. The image itself was not run.
- *[read from the code, not tested]* — nobody ran it. It is what the code says.

The old images running on the server today (the five listed in LAR-74) could **not** be pulled
without signing in to the registry, so nothing here was run on them. The sync-jobs image is private
and was left out entirely.

## Four things to know before reading the steps

1. **While any one agent's stored definition is still old-style, the keeper refuses to finish a
   save or an apply for every agent, and it stops the agent it was working on.** The keeper builds
   one shared firewall/allow-list from all agents' definitions, and that step throws "Unknown egress
   capability: atlas" (or `memory`, `brain`) on an old name belonging to *any* agent. The new
   definition has already been written by then, so the first two saves report an error but are
   stored; the third save goes through. *[seen via code run, not via image]* This is an engine
   fault, described at the end. **Fixed by LAR-104 (pull request #44). The keeper in
   `releases/2026-10-01-rc.3.json` (built from `d95f358`) has the fix, as did rc.2's; the one in rc.1
   does not:**
   with a keeper built after that fix, another agent's old name opens
   no network hosts and blocks nothing, and an agent's own old name is refused before anything is
   stored or stopped. *[keeper tests only, not via image]* Step 5 describes both keepers.
2. **"Healthy" does not mean "answering".** An agent with an unusable definition and no stored
   last-valid copy starts, answers its health address within about 20 seconds, and then fails every
   chat message. The keeper's one-minute health wait would call it healthy. Always send one
   message. *[seen locally (made-up data)]* **Fixed by LAR-105 (#47), in rc.3's agent images:**
   such an agent now stops before its health address opens, the keeper reports "did not become
   healthy", and the console says "The agent did not start within a minute. Its log says why; often
   it has no usable definition." Still send one message. *[agent-kit and keeper tests only, not via
   image]*
3. **An agent whose stored definition is old-style does not refuse to start; it limps.** With an
   old-style stored copy it runs on that copy, logs one line "running on the last valid
   definition … capability "brain" is not in KNOWN_CAPABILITIES", answers, but has no note or
   fact tools and logs an error about the missing "brain" description at every conversation.
   *[seen locally (made-up data)]* **Fixed by LAR-106 (#50), in rc.3's agent images:** the stored
   copy is re-checked by today's rules first; an old-style one is refused, and the agent stops as in
   point 2. Its log says why the folder was refused and why the stored copy was. So on rc.3 an agent
   whose folder and stored copy are both old-style does not start at all, which is why step 5
   comes before step 6. *[agent-kit tests only, not via image]*
4. **Script 088 needs one extra step for the way back** (put the owner default back on the
   meeting follow-up table), and it works. *[seen locally (made-up data)]*

## The order

The database scripts come first, all of them, with the agents stopped. The new keeper and console
come next, then the three definitions, then the agents. This matches LAR-74 section 2.

### Step 0. The day before and the evening of

- **Do:** take a fresh backup and run its check. Copy `keeper.json` and the agents' compose file
  somewhere safe, with the image fingerprints in them. Answer or dismiss every pending approval
  card. Write down how many unfinished conversations each agent has. *[read from the code, not tested]*
- **Success looks like:** the check passes for all four databases; the list of pending cards is
  empty. *[read from the code, not tested]*
- **Way back:** nothing has changed yet.

### Step 1. Stop the three agents

- **Do:** stop each agent the way the server stops them today (the keeper has no plain stop button;
  see LAR-74). The keeper, console and database stay up. *[read from the code, not tested]*
- **Success looks like:** the three agent containers are not running.
  *[read from the code, not tested]*
- **Way back:** start them again; they are still on the old images and the old database.
  *[read from the code, not tested]*

### Step 2. The shared database scripts, in this order

The order is LAR-74 section 2A: 037, 046, 048, 049, 050 (then the brief language line), 060, 061,
062, 063, 065, 070, 071, 072, 073, 074, 075, 076, 079, 078, 081, 082, then 083, 084, 085, then 086,
087, 089, then 077, and 088 last. The made-up installation ran all 29 of these, then the two
chief-of-staff scripts 004 and 005, with **no error from any of them**. *[seen locally (made-up
data)]*

- **Do, for 083, 085 and 077:** run the dry-run select in the file's header first, read every
  line, and only then apply. With the made-up data the dry runs said: 083 no change on all three
  tables it found; 085 would rename 3 sign-ins, 2 mail cursors and the keeper's saved mailbox
  connection (2 values); 077 would move 3 permission levels to `vault` and 2 history rows.
  *[seen locally (made-up data)]*
- **Do, for 085:** in the same window, change by hand the keeper's own setting
  (`google.principal` in its configuration file) and the three other settings named in
  `2026-09-19-oauth-principal-rename.md` to the register's id. Skip this and the keeper refuses to
  start the agent's email door with "Configure and select a Google mailbox before enabling email".
  *[seen via code run, not via image]*
- **Success looks like:** 085 prints its four "renamed" lines; afterwards every sign-in, cursor and
  the keeper's mailbox row carry the register's id; 088 leaves no default on the nine tables.
  *[seen locally (made-up data)]*
- **Repeatable:** every script was then run a second time, including the 083, 085 and 077 dry runs
  (now saying "no change") and the brief-language line. No error, and the database structure came
  out identical. *[seen locally (made-up data)]*
- **Way back:**
  - 085: the rollback block in its header put all sign-ins, cursors and the keeper's row back to
    the old spelling. *[seen locally (made-up data)]*
  - 077: the rollback block put the three permission levels back under `brain`, `atlas`. The two
    history rows stay on `vault`; the file itself says so. *[seen locally (made-up data)]*
  - 088: the old chief-of-staff image writes meeting follow-ups without naming an owner. After
    088 that write is refused ("null value in column principal … violates not-null constraint");
    after `ALTER TABLE meeting_followup_sent ALTER COLUMN principal SET DEFAULT '<owner id>';` the
    same write works. Whether the old console or sync jobs write the other eight tables without an
    owner was not checked (the old images could not be pulled).
    *[seen locally (made-up data)]*
  - All other scripts only add tables, columns and rows. Whether the old images tolerate them was
    not tested. *[read from the code, not tested]*
  - **Cannot be undone without the backup:** nothing in this list deletes data, but there is no
    script that puts the database back as a whole. Restoring the verified backup does: restoring
    the rehearsal's own pre-switch dump brought back the old permission rows, the old sign-in
    spelling, the old conversation-store key and the absence of the new tables.
    *[seen locally (made-up data)]*

### Step 3. The conversation-store upgrade, one database at a time

For each of the three agents' conversation stores and for the keeper's empty mould: the upgrade
script (chief-of-staff `006`, creative `002`; travel uses the chief-of-staff file), then the
regenerated `001-eve-workflow.sql`.

- **Do:** apply both files to each of the four databases, in that order.
  *[seen locally (made-up data)]* The rehearsal's "old layout" was rebuilt from the current files
  by undoing exactly what the upgrade script changes, because the real old layout is not in this
  repository; a real old store may differ.
- **Success looks like:** no error; the made-up conversation rows were all still there (216, 8,
  14 conversations; three events each), and the new `workflow_event_slots` table exists. Applying
  `001` alone, without the upgrade script first, fails with "multiple primary keys for table
  workflow_events are not allowed". Both files a second time: no error.
  *[seen locally (made-up data)]*
- **Way back:** there is no statement for this. Only the backup restores the old layout.
  *[seen locally (made-up data)]*

### Step 4. The new keeper and console, and the new agent image fingerprints

- **Do:** put the release candidate's keeper and console images in place, and put the three new
  agent fingerprints into `imageByRole` in the keeper's configuration (the keeper writes the
  agents' compose file itself). Do not start the agents yet. *[read from the code, not tested]*
- **Success looks like:** the keeper answers `definition.list` and `definition.get` for all three
  agents while they are still old-style, each reporting status "valid" and its old grants intact.
  *[seen via code run, not via image]* The keeper and console images themselves were not started
  locally, and what the console's editing screen shows for an old-style grant was not looked at.
- **Way back:** put the old keeper and console fingerprints back. *[read from the code, not tested]*

### Step 5. Re-save the three definitions in the new style (`vault`)

- **Do:** save the chief of staff, the creative agent and the travel agent in turn through the
  console, each with its `vault` grant (areas as in LAR-74 section 5).
- **With a keeper built after LAR-104 (#44), such as rc.3's:** each save goes through and no agent is stopped. The
  keeper logs one line per agent that is still old-style ("still grants atlas; it opens no network
  hosts until the agent is saved in the new style"). The old names never opened any hosts, so a
  not-yet-converted agent loses nothing. *[keeper tests only, not via image]*
- **With the rc.1 keeper (`ac23bcb`, before the fix): expect the first two saves
  to show an error.** The keeper has by then written each definition, and the stored copy is
  already new-style; the error comes from the shared allow-list step, and it leaves that agent
  stopped and marked "pending". The third save, made when the other two are already new-style,
  goes through. *[seen via code run, not via image]*
- **Success looks like:** all three stored definitions list `vault` and no `brain`, `atlas` or
  `memory`; each of the three is marked "pending: apply connection changes".
  *[seen via code run, not via image]*
- **If the keeper's own mailbox setting still has the old spelling** the chief-of-staff save is
  refused cleanly, before anything is written. Fix the setting and save again.
  *[seen via code run, not via image]*
- **Way back:** old images and the old keeper do not accept `vault`; they would need the old-style
  definition files back from the definition backup (`definition-backups.md`).
  *[read from the code, not tested]*

### Step 6. Start each agent on the new image (apply connection changes), one at a time

- **Do:** apply connection changes for each agent. The keeper stops it, renders the allow-list,
  starts it on the new image and waits up to about a minute for its health address.
  *[seen via code run, not via image]* for the keeper's steps (stop, allow-list check, allow-list
  apply, proxy reload, start, and the agent no longer "pending"); *[read from the code, not
  tested]* for the one-minute wait.
- **Success looks like:** health answers **and one chat message gets an answer**, with `vault`
  note and fact tools in the tool list. The chief-of-staff image did both against the migrated
  rehearsal database, started in 19 to 29 seconds on an emulated (slower) chip, with 216 made-up
  unfinished conversations present. The made-up unfinished conversations produced repeated failed
  attempts in the log ("Event type 'run_started' not supported for legacy runs"); the agent was
  unaffected. The real 216 may behave differently. *[seen locally (made-up data)]* The travel and
  creative images were not started.
- **If an agent "did not start within a minute":** on rc.3 that is what an unusable definition
  looks like (LAR-105, LAR-106). Read that agent's log; the line starts "[definition] this agent
  has no usable definition". Most likely step 5 was missed for it: save it in the new style and
  apply again. *[agent-kit and keeper tests only, not via image]*
- **Way back:** for the software, put the old fingerprints back in the keeper's configuration and
  apply again. That also needs the old-style definitions (step 5) and, if 088 has been applied,
  its extra step (step 2). The database is only undone by the backup.
  *[read from the code, not tested]*

### Step 7. Afterwards

- **Do:** the live checks in LAR-74 section 7, and the timer scripts in section 4.
  *[read from the code, not tested]*

## Answers to the three questions the rehearsal set out to answer

- **Can the new keeper run beside the old-style stored definitions?** It can read and list them
  without complaint. It cannot finish a save or an apply while any agent is still old-style.
  *[seen via code run, not via image]* The new console was not run.
- **Is re-saving one definition in the new style refused because the other two are old?** Yes,
  at the last step, after the new definition is already written, and the running agent is stopped.
  *[seen via code run, not via image]*
- **What does an agent on the new image do at first start with an old-style stored definition
  and no last-valid copy?** It starts and reports healthy, then fails every chat message, with the
  cause only in its log. With an old-style last-valid copy it runs degraded (see "Four things").
  *[seen locally (made-up data)]* On rc.3 it stops in both cases instead (LAR-105, LAR-106).
  *[agent-kit tests only, not via image]*

## Engine faults found (each has since been fixed in its own ticket)

1. **One old-style definition blocks every other agent's save, and a failed save stops the
   agent.** `services/keeper/lib/egress.ts:85` (and `packages/agent-kit/src/persona/capability-docs.ts:890`)
   throw on an unknown capability in *any* agent's grants; `services/keeper/lib/lifecycle.ts:226-228`
   stops the agent when that happens, and `lifecycle.ts:255` stops the agent *before* the same step
   during an apply. The operator sees only "keeper: action failed" in the rehearsal harness.
   Reproduce: `services/keeper/tests/old-definitions.rehearsal.mts`. Ticket LAR-104, fixed by
   pull request #44.
2. **An agent with no usable definition reports healthy.** (LAR-105) `services/chief-of-staff/agent/instrumentation.ts:73`
   logs "agent not registered" and carries on; `packages/agent-kit/src/definition-cache.ts:121-125`
   then throws at each conversation. Reproduce: `scripts/rehearsal/first-start.py --no-last-valid`.
   Ticket LAR-105, fixed by pull request #47.
3. **The stored "last valid" definition is not re-checked against today's rules.** (LAR-106)
   `definition-cache.ts:121-133` reuses an old-style copy; it then fails to describe its own
   capabilities (`capability-docs.ts:884`). Reproduce: `first-start.py` with the old-style definition.
   Ticket LAR-106, fixed by pull request #50.

## Still needs the real rehearsal

- First-start time with the real ~216 unfinished conversations against the one-minute health wait
  (here: 19 to 29 seconds, made-up conversations, emulated chip).
- The real data, the real old conversation-store layout, and the server's own settings files
  (`keeper.json`, the compose files, the secrets folder).
- rc.3's agent images against the rehearsal database: an old-style stored copy and a missing
  one should now both stop the agent (LAR-105, LAR-106). Not yet seen with an image.
- The release candidate's keeper, console, firewall helper and egress proxy images actually
  started, with the real firewall privileges and the real allow-list; the travel and creative
  agent images; the sync-jobs image (private, not touched).
- The console's editing screen with an old-style definition, and the console's own save path.
- The old images against the migrated database (they could not be pulled), including whether the
  old console or sync jobs write owner-less rows after 088.
- A real Google sign-in after the 085 rename, and the Telegram and Slack doors.
- A restore of a real backup.

## How to repeat the rehearsal

Start a throwaway Postgres container of your own (`pgvector/pgvector` as in the release file, with a
superuser role `lares`), then:

```
scripts/rehearsal/database-rehearsal.sh build
scripts/rehearsal/database-rehearsal.sh apply /tmp/pass1.log ; scripts/rehearsal/database-rehearsal.sh eve /tmp/eve1.log
scripts/rehearsal/database-rehearsal.sh apply /tmp/pass2.log ; scripts/rehearsal/database-rehearsal.sh eve /tmp/eve2.log
scripts/rehearsal/database-rehearsal.sh wayback
python3 scripts/rehearsal/first-start.py --image <runtime image> --agent-json <file> [--no-last-valid]
cd services/keeper && REHEARSAL_DATABASE_URL=<a copy of the rehearsal database> npx tsx tests/old-definitions.rehearsal.mts
```

None of these touch a real server, and every Docker object they make is named `lar98-`.
