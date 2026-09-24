#!/usr/bin/env bash
# brain-init-remote.sh — create the canonical Brain on the box.
# Run ONCE on lares-agent-1 as root. Idempotent: re-running is a no-op if /srv/brain.git exists.
set -euo pipefail

BARE=/srv/brain.git
WORK=/srv/brain

if [ -d "$BARE" ]; then
  echo "Bare repo already exists at $BARE — nothing to do."
  exit 0
fi

# 1. Bare canonical remote.
git init --bare "$BARE"
git -C "$BARE" symbolic-ref HEAD refs/heads/main

# 2. Working clone the box's agents read/write.
git clone "$BARE" "$WORK"
git -C "$WORK" config user.name  "lares-agent-box"
git -C "$WORK" config user.email "agent-box@example.com"

# 3. Lock directory for per-file advisory locks (Task 5).
mkdir -p "$WORK/.locks"

# 4. post-receive hook: fast-forward the working clone after every push, so
#    box-side reads always see the latest. --git-dir/--work-tree target the clone.
HOOK="$BARE/hooks/post-receive"
cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
set -euo pipefail
WORK=/srv/brain
while read -r _old _new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    git --git-dir="$WORK/.git" --work-tree="$WORK" fetch --quiet origin main
    git --git-dir="$WORK/.git" --work-tree="$WORK" reset --hard --quiet origin/main
  fi
done
HOOKEOF
chmod +x "$HOOK"

echo "Brain bare repo at $BARE, working clone at $WORK, post-receive hook installed."
