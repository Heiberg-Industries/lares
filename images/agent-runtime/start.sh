#!/bin/sh
set -eu
# Which settings this image cannot start without is NOT decided here. It is decided once, in
# `SETTINGS` (packages/vault-format/src/settings.ts), and rendered into the generated fragment
# below by `pnpm -C packages/agent-kit run generate:settings`. A hand-written list here drifted
# out of step with the code twice; this file no longer has one to drift.
#
# The fragment is run, not sourced, so it stays a script that also works on its own: it prints one
# plain sentence per problem — the setting's NAME, what breaks without it, and for a *_FILE
# setting the PATH it points at — and never a value, a secret's bytes, or a secret's length. Exit
# 78 is EX_CONFIG: "this installation is configured wrongly", not "the agent crashed".
guard="${LARES_REQUIRED_SETTINGS:-/usr/local/lib/lares/required-settings.sh}"
[ -r "$guard" ] || { echo "lares: the startup settings check is missing from this image ($guard)." >&2; exit 78; }
/bin/sh "$guard" || { echo "Set them in the installation's settings and start it again. \`lares doctor\` lists all of them." >&2; exit 78; }
PGPASSWORD="$(cat "$DATABASE_PASSWORD_FILE")"
export PGPASSWORD
# Eve reads WORKFLOW_POSTGRES_URL from its environment. Build that URL only in this
# process tree so the workflow login never shares the app password or appears in Compose.
if ! WORKFLOW_POSTGRES_URL="$(node -e 'try { const fs=require("node:fs"); const u=new URL(process.env.WORKFLOW_POSTGRES_URL); const file=process.env.WORKFLOW_POSTGRES_PASSWORD_FILE; if (!file || u.password || !["postgres:","postgresql:"].includes(u.protocol)) process.exit(78); let p=fs.readFileSync(file,"utf8"); if (p.endsWith("\n")) p=p.slice(0,-1); if (p.endsWith("\r")) p=p.slice(0,-1); if (!p.trim() || /[\r\n]/.test(p)) process.exit(78); u.password=p; process.stdout.write(u.toString()); } catch { process.exit(78); }')"; then
  echo "lares: workflow database credentials are unavailable." >&2
  exit 78
fi
unset WORKFLOW_POSTGRES_PASSWORD_FILE
export WORKFLOW_POSTGRES_URL
exec ./node_modules/.bin/eve start --host 0.0.0.0 --port 3000
