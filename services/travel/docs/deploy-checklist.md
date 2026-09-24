# eve-marcel deploy checklist

Marcel's most important job — the Reise-inbox sweep — is a **detached** promise. It reports
minutes later, by DM, or not at all. That makes it the one part of this service a deploy can
break invisibly, so a deploy is not finished when the container is healthy. It is finished when
a sweep has been seen reaching Gmail.

## Before

1. **Is a sweep running?** `/sveip` writes `/srv/eve-marcel/sweep-in-progress.json` while its
   backfill is in flight. Check it, and wait, or you will kill a sweep mid-run:

   ```sh
   ssh root@192.0.2.20 'cat /srv/eve-marcel/sweep-in-progress.json 2>/dev/null || echo "no sweep running"'
   ```

   A restart during a sweep is survivable — the extraction cache means re-running costs nothing,
   and since ORB-104 the next startup DMs Bendik that it happened — but it wastes his time.

2. **Disk**: `df -h /` on the box. Images accumulate ~1 GB per deploy and a full disk takes
   Postgres down with it.

3. **Serial**: one box deploy at a time.

## After — the sweep verification (MANDATORY)

A healthy container proves the server booted. It does **not** prove the sweep works: on
2026-08-17 three consecutive sweeps sent their ack and then made zero Gmail calls, and nothing
in the container's health, logs, or DMs said so. The only signal that told the truth was the
proxy log.

So, after every deploy, ask Bendik to run one `/sveip`, and within 60 seconds confirm Marcel
actually reached Google:

```sh
ssh root@192.0.2.20 'cd /opt/agent-box && docker compose exec -T slack-proxy \
  sh -c "tail -200 /var/log/squid/access.log" \
  | awk "\$3==\"172.18.0.25\" && /googleapis/" | tail -5'
```

Expect, within ~5 seconds of the ack: one `CONNECT oauth2.googleapis.com:443` (the token
refresh) followed by a stream of `CONNECT gmail.googleapis.com:443` (one per mail; a full sweep
is ~130).

- **Both present** → the deploy is done.
- **Neither present** → the sweep is not running, whatever the container says. Roll back to the
  previously pinned digest and investigate before doing anything else.

`172.18.0.25` is eve-marcel's pinned address on the internal network. It is also what the
egress seal is keyed to, so if it ever changes, both the seal and this check move with it.
