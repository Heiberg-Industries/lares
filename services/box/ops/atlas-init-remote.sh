#!/usr/bin/env bash
# atlas-init-remote.sh — create the canonical Atlas (business knowledge store) on the box.
# Run ONCE on lares-agent-1 as root. Idempotent: a no-op if /srv/atlas.git already exists.
# Mirrors brain-init-remote.sh; the Atlas is a SEPARATE repo from /srv/brain (physical
# isolation — business agents mount only the Atlas, never the personal Brain).
set -euo pipefail

BARE=/srv/atlas.git
WORK=/srv/atlas

if [ -d "$BARE" ]; then
  echo "Bare repo already exists at $BARE — nothing to do."
  exit 0
fi

# 1. Bare canonical remote.
git init --bare "$BARE"
git -C "$BARE" symbolic-ref HEAD refs/heads/main

# 2. Working clone the box's agents read (Saga, Calliope) / write (Calliope, gated).
git clone "$BARE" "$WORK"
git -C "$WORK" config user.name  "lares-agent-box"
git -C "$WORK" config user.email "agent-box@example.com"

# 3. post-receive hook: fast-forward the working clone after every push (Mac sync target),
#    so box-side reads always see the latest brand notes.
HOOK="$BARE/hooks/post-receive"
cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
# umask 0002: the reset --hard below creates working-tree dirs (e.g. _inbox) — without this
# they'd be created non-group-writable (root umask 022), so Calliope's gated "save a winner"
# write (UID 10001, group saga) would hit Permission denied. 0002 keeps the tree group-writable.
umask 0002
set -euo pipefail
WORK=/srv/atlas
while read -r _old _new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    git --git-dir="$WORK/.git" --work-tree="$WORK" fetch --quiet origin main
    git --git-dir="$WORK/.git" --work-tree="$WORK" reset --hard --quiet origin/main
  fi
done
HOOKEOF
chmod +x "$HOOK"

# 4. Group-shared perms so the non-root agent containers (UID/GID 10001, group `saga`) can
#    read — and Calliope can gated-write — the repos. Same recipe as /srv/brain.
chown -R root:saga "$BARE" "$WORK"
chmod -R 2775 "$BARE" "$WORK"                 # setgid: new files inherit group `saga`
git -C "$BARE" config core.sharedRepository group
git -C "$WORK" config core.sharedRepository group

echo "Atlas bare repo at $BARE, working clone at $WORK, post-receive hook + group perms set."
echo "Next: push the Mac vault (~/Developer/lares-atlas-vault) to $BARE over the tailnet."
