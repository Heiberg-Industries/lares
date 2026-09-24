#!/usr/bin/env bash
# vault-purge.sh — the deliberately hard-to-run second half of "erase a person"
# (W5B-s9). Erasing a person (erase-person.ts, the database and vault halves)
# removes a file from the working tree and commits that removal — but a git commit
# only stops NEW clones from seeing the old content. `git log -p` can still show
# every byte of a removed file, forever, in this same repository's history. This
# script is the separate, explicit step for someone who has decided that is not
# good enough: it rewrites every commit that ever touched the given file paths,
# using `git filter-repo`, so the content no longer exists under any commit id in
# this one local copy.
#
# WHY THIS IS ITS OWN COMMAND, NOT A FLAG ON THE ERASE ITSELF. Rewriting history
# changes every commit id after the earliest touched commit. Every OTHER clone of
# this vault is now out of date in a way `git pull` cannot fix (it must be
# re-cloned), and any job that remembers "the commit I last saw" now holds an id
# that no longer exists. That is a coordinated decision a person makes on purpose,
# never a side effect of an ordinary, everyday erase.
#
# WHY IT REFUSES BY DEFAULT. The only way to make this script do anything is to
# type out --i-understand-this-rewrites-history in full. There is no short flag,
# no environment variable, and no "yes to all" — a command this destructive should
# never run by muscle memory or a half-copied instruction.
#
# WHY IT NEVER SENDS THE RESULT ANYWHERE. This script only ever touches the local
# copy named by --vault. Once it is done, only the operator decides whether, and
# when, to send the rewritten history anywhere else — that decision belongs to a
# person who has looked at the result, not to this script.
set -euo pipefail

VAULT=""
PATHS=()
CONFIRMED=0

usage() {
  cat <<'EOF' >&2
Usage: vault-purge.sh --vault <path> --path <file> [--path <file> ...] \
         --i-understand-this-rewrites-history

Rewrites the vault's git history so the given file paths never existed in any
commit. This rewrites every commit id in the repository at --vault: every other
clone must be re-cloned afterwards, and any job's recorded "last commit seen"
becomes invalid. Nothing is ever sent anywhere by this script.

  --vault <path>   the vault's git working directory (must be a clean work tree)
  --path <file>    a file path to remove from every commit, relative to the
                    vault root; repeat for more than one file
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --vault)
      if [ $# -lt 2 ]; then
        echo "vault-purge: --vault needs a value" >&2
        exit 2
      fi
      VAULT="$2"
      shift 2
      ;;
    --path)
      if [ $# -lt 2 ]; then
        echo "vault-purge: --path needs a value" >&2
        exit 2
      fi
      PATHS+=("$2")
      shift 2
      ;;
    --i-understand-this-rewrites-history)
      CONFIRMED=1
      shift
      ;;
    -h|--help)
      usage
      exit 2
      ;;
    *)
      echo "vault-purge: unknown argument '$1'" >&2
      usage
      exit 2
      ;;
  esac
done

# Checked first, before any other refusal, so this message is what a person sees
# no matter what else was or was not given on the command line.
if [ "$CONFIRMED" -ne 1 ]; then
  echo "vault-purge: refusing to run. This rewrites every commit id in the vault's" >&2
  echo "vault-purge: history — every other clone and every sync job's recorded" >&2
  echo "vault-purge: commit is invalidated by it. Pass --i-understand-this-rewrites-history" >&2
  echo "vault-purge: once you mean it." >&2
  usage
  exit 2
fi

if [ -z "$VAULT" ]; then
  echo "vault-purge: refusing — no --vault path was given" >&2
  exit 2
fi

if [ ${#PATHS[@]} -eq 0 ]; then
  echo "vault-purge: refusing — no --path was given; there is nothing to purge" >&2
  exit 2
fi

# Every path is checked before anything else touches the vault, so a typo cannot
# reach into a directory outside it or address a file by an absolute path the
# operator did not mean.
for p in "${PATHS[@]}"; do
  case "$p" in
    /*)
      echo "vault-purge: refusing — path '$p' starts with '/'; paths must be relative to the vault root" >&2
      exit 2
      ;;
    *..*)
      echo "vault-purge: refusing — path '$p' contains '..'" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$VAULT" ]; then
  echo "vault-purge: refusing — '$VAULT' is not a directory" >&2
  exit 2
fi

if ! git -C "$VAULT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "vault-purge: refusing — '$VAULT' is not a git work tree" >&2
  exit 2
fi

# A dirty work tree could have its uncommitted changes silently discarded or
# reordered by the rewrite below; refusing here means the operator's own
# in-progress work is never at risk of being the thing that gets rewritten.
DIRTY=$(git -C "$VAULT" status --porcelain)
if [ -n "$DIRTY" ]; then
  echo "vault-purge: refusing — '$VAULT' has uncommitted changes; commit or discard them first" >&2
  exit 2
fi

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "vault-purge: git filter-repo is not installed." >&2
  echo "vault-purge: install it first: pip install git-filter-repo" >&2
  exit 2
fi

FILTER_ARGS=()
for p in "${PATHS[@]}"; do
  FILTER_ARGS+=(--path "$p")
done

git -C "$VAULT" filter-repo --invert-paths "${FILTER_ARGS[@]}" --force

echo "vault-purge: done. History has been rewritten in this one local copy only."
echo "vault-purge: every other clone of this vault must be re-cloned from this copy — the old commit ids no longer exist anywhere in it."
echo "vault-purge: any sync job's recorded last-seen commit is now invalid and must be re-established from a fresh clone."
echo "vault-purge: nothing has been sent anywhere by this script. Sending this rewritten history anywhere else is your decision, made deliberately, when you are ready."
