# Current-layout Lares backup rehearsal

This is the isolated `/opt/lares` path used by LAR-50. Do not deploy it on the
older `/opt/agent-box` installation or in production as part of this run.

## Required private inputs

Create a private EU S3 bucket outside the test server's location. In
`/etc/lares/backup.env` (root-owned, mode `0400`), set:

```sh
LARES_CURRENT_LAYOUT=1
RESTIC_REPOSITORY=s3:https://fsn1.your-objectstorage.com/BUCKET/restic
AWS_ACCESS_KEY_ID=...                 # bucket credential, never commit
AWS_SECRET_ACCESS_KEY=...             # bucket credential, never commit
RESTIC_PASSWORD_FILE=/etc/lares/restic-password
AGE_SECRETS_RECIPIENT=age1...         # off-box identity's public recipient
HC_URL=https://hc-ping.com/...       # live daily check with owner alert
```

The repository password belongs in a separate root-only file. The age private
identity, repository password and S3 credentials must also be escrowed off the
test server. Prove that escrow from another machine by reading the repository.
Never paste these values into Git, chat, Linear, or a command line that remains
in shell history. An empty heartbeat target must fail verification.

## Install and prove

Install the distribution's `age` and `restic` packages. Copy the reviewed
`backup.sh` and `backup-verify.sh` into `/opt/lares` as root-owned mode `0750`,
and their `lares-backup*.service` and `.timer` units into
`/etc/systemd/system`. The current-layout flag is required: it chooses the
single Compose file and archives only `/srv/lares/agents`,
`/srv/lares/retired`, `/srv/taste`, all non-template database dumps, and an
age-encrypted `/etc/lares` bundle. Plaintext `/srv/lares/secrets` is never a
restic input. A new unclassified Lares data directory fails the job.

After `restic init`, run one backup. Read the newest remote snapshot back,
check the database list and the three portable stores, and run
`backup-verify.sh`. Confirm its `backup_status.verify` row, the live heartbeat
receipt, and the owner's alert route. Then enable both timers and inspect
their next scheduled runs. A successful command alone does not mark the
installation protected. Do not use the older monthly drill script unchanged:
it still assumes the dual-Compose `/opt/agent-box` layout.

Before another OS rebuild, decrypt and inspect the escrow from off-box, and
record the remote snapshot ID, source revision, archive/manifest checksums,
database and fixture counts, and owner approval to discard the current disk.
After rebuild, restore into the fresh target, exercise the guarded gateway-key
repair and confirm the agent and Preferences marker. Record the final teardown
inventory and ask separately before deleting the server, IPs or bucket.
