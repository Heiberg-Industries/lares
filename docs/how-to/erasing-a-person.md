# Erasing a person

This page describes the tested path: what happens when you ask Lares to erase a member
of your installation, and — just as important — what erasing does **not** reach. There
is no promise of support here, only what has been built and checked.

"Erasing a person" only applies to someone who is a **member of this installation** —
someone listed in the people register. If you name anyone else (a contact, a client, a
name that only appears in a note about them), the command refuses and does nothing. This
is not a way to delete a note about a third party; it is a way to remove a member and
everything the system holds about them, on their own request.

## What an erase removes immediately

Running the erase command removes, in one step:

- **Their entry in the people register itself** — after everything else, so that if
  anything below needs to know who they were, it still can, until the very last moment.
- **Everything they wrote or that is about them, everywhere it is stored** — standing
  facts, notes, agent notes, memory records, conversation history, reminders, and every
  other place a person is recorded in the database — matched under every spelling their
  identity has ever been stored under, not just the current one. If an old system used a
  different id for the same person, rows under that old id are removed too.
- **Their files in the vault** (the folder of notes and documents Lares keeps) — the
  notes marked as theirs, and the notes where they are the only person named, including
  files in folders that ordinary search does not show you. **A note that also names
  other people is left exactly as it is**, because it is those people's note too. The
  report lists every such note, and you decide by hand what to do with each one.
- **The record of anything synced from an outside source** (like Notion) that pointed at
  one of those now-removed files, so the file is not silently re-created the next time
  a sync job runs.

One exception: a handful of tables exist only to record **who did what** — an audit
trail, not the person's own information. In those tables, the row itself stays (so the
history of "who approved this" is not falsified), but the person's name in it is
replaced with the word `erased`.

The erase command always tells you exactly what it removed, table by table and file by
file, so you can see for yourself that it did what it says.

## What it does not reach, and why

Even a complete, successful erase leaves four things untouched. This is not a bug —
each one is a different kind of record with its own reason for existing:

1. **Git history.** Removing a file from the vault and saving that removal only stops
   *new* copies from containing it. The vault is a git repository, and git keeps every
   version of every file it has ever seen. Anyone with a copy of the vault can still run
   `git log -p` and see the old, removed content. Making history itself forget a file is
   a separate, much bigger step — see "Rewriting history" below.
2. **Backups.** A backup taken before the erase still has a copy of everything as it was
   at that moment. Erasing does not reach into old backups and edit them; it only
   affects things going forward.
3. **An open session.** The framework the agents run on keeps its own working copy of a
   conversation — the messages and what the agent did — for as long as that conversation is
   still open, so it can pick up where it left off after a restart. Those working rows are
   not a historical record; they are removed on their own schedule once a session has
   closed. The erase command does not reach into them while a conversation is still open.
4. **The contacts book's separate database.** The part of the system that keeps track of
   the people you know — contacts and your interactions with them — stores its records in
   its own separate database, outside the erase command's reach today.

## Running it

**Always do a dry run first.** A dry run shows you exactly what *would* be removed,
without removing anything. Only once you have read that list and are satisfied should
you run it for real.

```
pnpm -C services/box run erase-person -- <person> --vault <path to a vault>
```

Give `--vault` once for every vault this person might have notes in. If you leave it
out, the notes are not looked at at all, and the report says so.

This is the dry run — nothing is deleted or changed. Read the report it prints. It
lists, table by table and file by file, everything that would be removed, and it lists
anything it cannot reach (the four things above, plus anything unusual it found).

When you are ready to actually erase, add `--apply`:

```
pnpm -C services/box run erase-person -- <person> --vault <path to a vault> --apply
```

A real run first checks that the database part can go through, and only then touches
any file. The removal is saved in the vault as one local change that names nobody. It is
**not sent to your git server**: the report prints the exact command for that, for you
to run when you have read the report.

This can only be run from a command line — there is no button for it anywhere, in any
chat or console. That is deliberate: erasing a person is significant enough that it
should never happen by accident from a casual message.

## Rewriting history, if you must

If removing a file from the vault's *current* state is not enough — if you specifically
need old versions of that file to disappear from the vault's git history too — there is
a separate command for that: `services/box/ops/vault-purge.sh`.

This is a much bigger, much more disruptive step than an ordinary erase, and it is kept
deliberately hard to run by accident:

- It refuses to do anything unless you pass an explicit flag,
  `--i-understand-this-rewrites-history`, spelled out in full.
- It only ever works on one local copy of the vault at a time, and it never sends
  anything anywhere on its own — not even a normal update. Once it finishes, sending the
  result anywhere else is entirely up to you.
- It requires a tool called `git filter-repo` to be installed first. If it is not
  installed, the command tells you so and stops, rather than trying and failing halfway.

**The cost of running it is real, and it does not go away:**

- Rewriting history changes the identifying number (the "commit id") of every commit
  from that point forward. Every other copy of this vault — on any other computer or
  server — must be thrown away and re-downloaded fresh. There is no way to "update" an
  old copy onto the new history; it has to be replaced entirely.
- The copy on your git server (where the vault is pushed to) still has the old history
  until you replace it with the rewritten one, and some hosting services keep removed
  content for a while even after that. Old backups are not touched either.
- Any job that keeps track of "the last change I saw" (for example, the job that syncs
  the vault with Notion) now has a record that points at a commit id which no longer
  exists. That job's memory of where it left off has to be re-established from a fresh
  copy of the vault.

Because of this, rewriting history is not something to do routinely, or as a normal part
of erasing someone. It exists for the rarer case where a person specifically needs old
content gone from history itself, and it is only ever done as its own deliberate,
coordinated step — dry run an ordinary erase first, look at what it would remove, and
only reach for the history rewrite if that genuinely is not enough.
