# Optional Git backups of agent definitions

Lares runs and saves agent definitions without GitHub or another Git hosting account.
Git backup is off by default: an absent or blank `agents.backup_remote` setting means
“not enabled.” No repository connection, checkout or credential is needed in that mode.

Each local create, save or retirement returns one of three backup states:

- `disabled`: Git backup is not enabled. The definition was saved locally.
- `saved`: the definition was saved locally and its Git backup was pushed successfully.
- `failed`: the definition was saved locally, but the configured Git backup failed.

The Console displays the informational “Git backup is not enabled” message for disabled
backups. It reports an actual configured backup failure separately. The legacy `ok` result
is true only after a successful Git push; a false value alone does not mean the local save
failed. Disabling Git backup never deletes local definitions or existing backup history.

## What it copies

Only `agent.json`, `duties.md` and `voice.md` are copied under `definitions/<agent>/` in the
chosen repository. These contain agent settings, permissions, duties and personality.
They can include personal or business information, so use a private repository. Any secret
someone types into those files would also be copied; this feature does not redact their text.

Conversation history, workflow files, databases and credential files are not included.
Git history is an extra recovery aid, not a complete server backup. Configure and test
separate encrypted backups for the installation's data and credentials.

## Optional setup for an installation administrator

There is currently no one-click GitHub connection wizard. Set this up once for the whole
installation, not once per agent:

1. Create a private repository specifically for definition backups. Initialize it with a
   README so it has a default branch. Keep it separate from the public Lares source and the
   installation's deployment configuration.
2. Give keeper a dedicated credential that can read and push to that repository. Keep its
   private key on the server, accessible only to keeper; do not mount it in agent containers
   or commit it to any repository. Configure noninteractive SSH and verified `known_hosts`.
   Never reuse a developer's personal SSH key. GitHub deploy keys apply to an entire single
   repository, so a separate definitions repository limits what that credential can modify.
3. Set the installation's `agents.backup_remote` setting to the repository's SSH address.
   The keeper's `backupDir` must be a separate writable checkout location. If changing the
   remote, use a new checkout path; keeper refuses a mismatch with an existing checkout.
4. Save a definition and confirm both a successful backup result and its commit in the
   private repository. A missing or rejected credential is a failure, not a disabled backup.

To turn off Git backups, set `agents.backup_remote` to an empty string. Existing local saves
and previously pushed history remain. Revoke an unused server credential separately.
Enabling backups does not automatically upload every existing definition: save each one to
create its first backup. Git backup never pulls remote definitions into the running agents.

The open-source Lares repository contains no user's backup credential. Every installation
that opts into this feature uses its own repository and credential.
