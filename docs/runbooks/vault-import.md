# Bringing an existing folder of notes into the Vault

`lares vault import` takes a folder of notes you already have (an Obsidian vault, a folder of
Markdown files, an exported note app) and copies it into your Lares Vault. It never changes the
original folder, and it never overwrites a note that is already in the Vault.

You always look first. The first command only prints a plan. Nothing is written until you run a
second command that names that exact plan.

## Before you start

- You need a finished install (`lares doctor` is clean) and a root shell on the server.
- Put the folder on the server and keep it. The original stays yours; Lares does not move or
  delete it, and it does not copy the folder's Git history (only the commit it was at is noted).
- Back up first if you like (`sudo lares backups`). The import only adds files, and each batch is
  its own commit, so a mistake can be reversed with ordinary Git, but a backup costs nothing.

## 1. Preview

```bash
sudo lares vault import /path/to/my-notes
```

Nothing is written. The output has four parts:

1. **A table per top-level folder**: which area it goes to (`private` is the owner's own area,
   `shared` is the organisation's), how many notes and attachments, and the size.
2. **The stamp line**: how many notes get `lares_origin: synced` (see below) and how many carry a
   wider stamp that would be narrowed.
3. **This run**: how many files will be added, how many are already in the Vault, how many have
   changed in the source since, how many conflict, how many you deleted after an earlier import,
   and how many look like duplicates.
4. **Stays behind by design**: hidden folders (`.obsidian`, `.trash`, `.git`), links, hard-linked
   files, folders that are their own Git repository, `taste/`, `_meta` files that are not dream
   notes, conversation logs, attachments no note refers to, and anything over the size limits.

If the plan is **blocked**, it says why and prints no plan-id. Fix the cause and preview again.
Typical causes: two notes would end up at the same path, two paths differ only by capital letters,
or a note marked private (`scope: private` or `scope: participants`) is headed for the shared area.

Last line of a good preview: `plan-id: <64 characters>`.

## Where each note goes

The default is **private**, the owner's own area. Nothing goes to the shared area unless you say
so. The order for each note is:

1. `--skip <pattern>` leaves matching files out.
2. `--shared <folder>` and `--private <folder>` send a whole folder to that area (repeat the
   option for more folders). The folder keeps its name.
3. A map file, with `--map <file>` or a file called `.lares-import.json` in the folder being
   imported. Its rules are tried in order and the first match wins:

   ```json
   {
     "default": "private",
     "rules": [
       { "match": "Company/**", "area": "shared", "strip": "Company/" },
       { "match": "Personal/**", "area": "private", "strip": "Personal/" },
       { "match": "Archive/**", "skip": true }
     ]
   }
   ```

   `strip` removes that start of the path, so `Company/plans/q1.md` becomes `plans/q1.md`.
4. The note's own `scope:` line: `org` means shared, `private` or `participants` means private.
5. Otherwise private.

A note marked private is never sent to the shared area; the plan is blocked instead.

Some folders are handled the same way whatever the rules say: `_inbox/` stays private;
`_meta/dream/<date>.md` (dream notes) is kept in the private area so dreaming does not start from
nothing; the rest of `_meta/` is left behind; `taste/` is left behind (taste is adopted
separately). `--include-conversations` also brings `_meta/conversations/`. Conversation logs are
kept out of search and are replaced by the conversation record, so most people leave them.

## What the stamp means

Every imported note gets one added line, `lares_origin: synced`: "this arrived from outside".
Nothing else in the note changes (the body, the other front matter, line endings). Use
`--origin owner` after you have read the preview and know every note is yours. A note that
already carries a stamp keeps it unless it is wider than the one you chose, in which case it is
narrowed. An import never makes anything look more trusted than you said.

## Attachments

Images and other files are brought in only when an imported note links to them
(`![[photo.png]]`, `![](files/scan.pdf)`, `[[contract.pdf]]`). Each can be 25 MB at most and all
together 500 MB; a bigger set blocks the plan (use `--skip` on the largest folders). They are not
searched. They land beside the notes that use them, in the same area.

## 2. Apply

```bash
sudo lares vault import /path/to/my-notes --apply --confirm <plan-id>
```

Use the same folder and the same options as the preview. If the folder, the options or the Vault
changed since, the plan-id no longer matches and nothing is written; preview again.

The import runs in batches of up to 500 files. Each batch is one Git commit, pushed to the backup
repository, so if something stops half way the finished batches are complete and a re-run adds
only what is missing. Two thousand notes take well under a minute.

It ends with a health check, and prints the numbers: how many notes the Vault now lists against
how many it should, that a sample note is found by search, that the working copy is clean and that
the backup repository is up to date. There is no separate search index to build: notes are found
straight from the files.

## Running it again

The import keeps a small record of what it brought in, in `_meta/import/<id>/` inside each area
(one file per batch, part of the Vault and therefore of every backup). On a re-run:

| What it finds | What it does |
| --- | --- |
| A note not in the Vault yet | adds it |
| A note you deleted from the Vault after importing | leaves it deleted |
| A note you edited in the Vault | leaves your version, reports a conflict |
| A different note already at that path | leaves it, reports a conflict |
| Identical text already elsewhere in the area | skips it as a probable duplicate |
| A note whose source changed since the import | reports "source newer" and leaves the Vault copy alone |

Updating notes whose source changed (`--update`) does not exist yet. Move or copy by hand if you
want the newer version.

The record is tied to the folder's name. Importing from a folder with a different name starts a
new record, so everything already there is reported as a conflict rather than overwritten.

## Things to know

- **A later `lares restore` onto this server is refused**, because restore needs empty Vault
  stores and they are no longer empty. Restore is for a fresh server. Backups and exports are
  unaffected: imported notes are backed up like any other note.
- Only the owner's private area and the shared area exist, so the import only fills those two.
  A folder that holds several people's private notes cannot be split between members yet.
- Hidden files and folders, links and hard links stay behind on purpose, so a note app's own
  settings or a link out of the folder never reach the Vault.
- Notes must be valid UTF-8 text. Others are reported and left behind.
- Nothing is sent anywhere; the import runs entirely on the server.

## If something looks wrong

Run `sudo lares doctor`. Each batch is a commit in `/srv/vault/<kind>/<area>`; `git log` there
shows them (commit messages begin `import <id>:`), and `git revert` undoes one the usual way.
Never delete files from the Vault folders by hand; ask the agent or use Git.
