#!/usr/bin/env bash
# setup-backups.sh — one command that switches the backup jobs on and proves them once.
# Run it as `install.sh --backups` (which hands over to this file) or directly.
#
# It asks where backups go, refuses unsafe answers BEFORE it writes anything, then:
#   - writes /etc/lares/backup.env (0400) and, when none exists, a generated restic password
#     file /etc/lares/restic-password (0400) after the owner confirms it is saved elsewhere;
#   - copies backup.sh, backup-verify.sh and restore-drill.sh to /opt/lares (0750) and the six
#     systemd units to /etc/systemd/system, refreshed from this checkout on every run;
#   - opens the restic repository, or creates it only when restic says plainly it is absent;
#   - enables the three timers, then runs backup -> restore drill -> verify once. It says
#     "Protected" only when all three succeeded.
#
# Safe to run again: with the same answers nothing changes and nothing is re-initialised.
# LARES_PREFIX keeps every write testable; host commands resolve from PATH so tests can put
# logging stubs ahead of them. NO SUDO: it refuses when it is not already root. Nothing
# phones home; the only network use is restic reaching the repository the owner named and the
# jobs pinging the heartbeat address the owner named.
#
# Exit codes (same scheme as install.sh): 0 ok · 64 bad usage · 75 a first-run job failed ·
# 77 not running as root · 78 refused (nothing was changed).
set -euo pipefail
umask 077

EX_OK=0
EX_USAGE=64
EX_TEMPFAIL=75
EX_NOTROOT=77
EX_REFUSED=78

HERE="$(cd "$(dirname "$0")" && pwd)"
ORIGINAL_ARGS=("$@")

say() { printf 'backups: %s\n' "$1"; }
die() { printf 'backups: %s\n' "$1" >&2; exit "$2"; }

usage() {
  cat <<'EOF' >&2
Usage: setup-backups.sh [--dry-run] [--yes] [--prefix <dir>]
                        [--repository <where>] [--password-file <path>] [--password-saved]
                        [--age-recipient <age1...>] [--hc-url <https://...>]
                        [--s3-credentials-file <path>] [--accept-same-machine]
                        [--reconfigure] [--skip-first-run]

Switches on the nightly backup, the daily check and the monthly restore rehearsal, and
proves them once. Refuses, changing nothing, when an answer is unsafe.

  --repository         sftp:user@host:/path, s3:https://host/bucket, or a path on a second disk
  --password-file      root-only file holding the repository password (default
                       /etc/lares/restic-password; generated if it does not exist)
  --password-saved     with --yes: you confirm a generated password is saved somewhere else
  --age-recipient      the PUBLIC age key (age1...); the private key stays off this server
  --hc-url             the https address of your uptime check (healthchecks.io style)
  --s3-credentials-file  root-only file with AWS_ACCESS_KEY_ID= and AWS_SECRET_ACCESS_KEY=
                       lines (s3: repositories only; never pass keys on the command line)
  --accept-same-machine  allow a local-path repository on this server's own disk (not a real backup)
  --reconfigure        replace an existing /etc/lares/backup.env that differs from these answers
  --skip-first-run     do not run backup, drill and verify once at the end
  --dry-run            say what this would do, and change nothing
  --yes                do not ask for confirmation (unattended)
  --prefix <dir>       treat this directory as the install root instead of / (for testing)
  -h, --help           show this message
EOF
}

DRY=0
ASSUME_YES="${LARES_ASSUME_YES:-0}"
PREFIX_ARG=""
REPO_FLAG=""
PWFILE_FLAG=""
PW_SAVED=0
RECIPIENT_FLAG=""
HC_FLAG=""
S3CRED_FLAG=""
SAME_MACHINE=0
RECONFIGURE=0
SKIP_FIRST=0

need_value() { [ "$2" -ge 2 ] || { echo "backups: $1 needs a value" >&2; exit "$EX_USAGE"; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --prefix) need_value "$1" $#; PREFIX_ARG="$2"; shift 2 ;;
    --repository) need_value "$1" $#; REPO_FLAG="$2"; shift 2 ;;
    --password-file) need_value "$1" $#; PWFILE_FLAG="$2"; shift 2 ;;
    --password-saved) PW_SAVED=1; shift ;;
    --age-recipient) need_value "$1" $#; RECIPIENT_FLAG="$2"; shift 2 ;;
    --hc-url) need_value "$1" $#; HC_FLAG="$2"; shift 2 ;;
    --s3-credentials-file) need_value "$1" $#; S3CRED_FLAG="$2"; shift 2 ;;
    --accept-same-machine) SAME_MACHINE=1; shift ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    --skip-first-run) SKIP_FIRST=1; shift ;;
    -h|--help) usage; exit "$EX_USAGE" ;;
    *)
      echo "backups: I do not know the argument '$1', so I have not done anything." >&2
      usage
      exit "$EX_USAGE"
      ;;
  esac
done

PREFIX="${PREFIX_ARG:-${LARES_PREFIX:-/}}"
# P: where a logical path (/etc/lares/...) really lives, given the prefix.
P() { printf '%s%s' "${PREFIX%/}" "$1"; }

ETC_LARES=$(P /etc/lares)
OPT_LARES=$(P /opt/lares)
SYSTEMD_DIR=$(P /etc/systemd/system)
ENV_LOGICAL=/etc/lares/backup.env
ENV_FILE=$(P "$ENV_LOGICAL")
DEFAULT_PW_LOGICAL=/etc/lares/restic-password

# --- 0. root ------------------------------------------------------------------------------
ROOT_ID=$(id -u 2>/dev/null) || ROOT_ID=""
if [ "$ROOT_ID" != "0" ]; then
  die "this needs to run as root (found user id '${ROOT_ID:-unknown}'). Try again with: sudo $0 $*" "$EX_NOTROOT"
fi

ADMISSION_PREFIX="${PREFIX:-/}"
TEST_OWNER_FLAG=""
[ "${LARES_MAINTENANCE_TESTING:-}" = 1 ] && TEST_OWNER_FLAG=1
if [ "${LARES_MAINTENANCE_ADMITTED:-}" = 1 ]; then
  if [ "$TEST_OWNER_FLAG" = 1 ]; then
    python3 "$HERE/maintenance-custody.py" assert-normal-held "$ADMISSION_PREFIX" setup-backups --test-owner || exit 78
  else
    python3 "$HERE/maintenance-custody.py" assert-normal-held "$ADMISSION_PREFIX" setup-backups || exit 78
  fi
else
  if [ "$TEST_OWNER_FLAG" = 1 ]; then
    exec python3 "$HERE/maintenance-custody.py" run-normal "$ADMISSION_PREFIX" setup-backups --test-owner -- "${ORIGINAL_ARGS[@]}"
  else
    exec python3 "$HERE/maintenance-custody.py" run-normal "$ADMISSION_PREFIX" setup-backups -- "${ORIGINAL_ARGS[@]}"
  fi
fi

WROTE=""
WORK=$(mktemp -d "${TMPDIR:-/tmp}/lares-backups-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# --- 1. this box must be a current-layout install, with the tools the jobs need --------------
[ -f "$OPT_LARES/compose.yaml" ] && [ -d "$ETC_LARES" ] || die "this is not a finished Lares installation: /opt/lares/compose.yaml or /etc/lares is missing. Run the installer first. Nothing was changed." "$EX_REFUSED"

missing=""
for tool in restic age curl systemctl; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  apt_pkgs=$(printf '%s' "$missing" | sed 's/ systemctl//; s/^ *//')
  msg="these tools are missing:$missing."
  [ -n "$apt_pkgs" ] && msg="$msg Install them with: apt-get install -y $apt_pkgs"
  die "$msg Nothing was changed." "$EX_REFUSED"
fi

# --- 2. existing settings (used as defaults, so a re-run needs no new answers) ---------------
MANAGED_KEYS="LARES_CURRENT_LAYOUT RESTIC_REPOSITORY RESTIC_PASSWORD_FILE AGE_SECRETS_RECIPIENT HC_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"

# private_problem <file>: prints why a secrets file is unsafe to trust, or nothing when it is
# owned by root with no group/other access.
private_problem() {
  local owner mode
  owner=$(stat -c %u "$1" 2>/dev/null || echo unknown)
  mode=$(stat -c %a "$1" 2>/dev/null || echo 777)
  if [ "$owner" != "0" ]; then
    printf 'it is not owned by root (owner id %s)' "$owner"
  elif [ $(( 8#$mode & 8#077 )) -ne 0 ]; then
    printf 'it is readable by others (mode %s)' "$mode"
  fi
}
# require_private <file> <what>: refuse, before reading the file, unless it is root-only.
require_private() {
  local why
  why=$(private_problem "$1")
  [ -z "$why" ] || die "$2 is not safe to use: $why. Fix it with: chown root:root '$1' && chmod 600 '$1', then run this again. Nothing was changed." "$EX_REFUSED"
}

# env_get <file> <key>: the value a shell would see after sourcing the file. A file that is
# not root-only is never sourced.
env_get() {
  [ -f "$1" ] || return 0
  [ -z "$(private_problem "$1")" ] || return 0
  # shellcheck source=/dev/null
  ( set +eu; . "$1" >/dev/null 2>&1; eval "printf '%s' \"\${$2:-}\"" )
}

EXISTING_ENV=0
if [ -f "$ENV_FILE" ]; then
  EXISTING_ENV=1
  require_private "$ENV_FILE" "the existing $ENV_LOGICAL"
fi
# A server set up by hand, before this command, keeps its settings elsewhere; replacing that
# setup is a decision for the owner.
if [ -f "$(P /etc/agent-box/backup.env)" ] && [ "$RECONFIGURE" != 1 ]; then
  die "this server already has an older backup setup (/etc/agent-box/backup.env) that this command would replace. Nothing was changed. If you mean to replace it, run again with --reconfigure." "$EX_REFUSED"
fi
old() { env_get "$ENV_FILE" "$1"; }

ask() { # ask <prompt> <flag-name> -> prints the answer
  local answer=""
  if [ "$ASSUME_YES" = 1 ]; then
    return 1
  fi
  printf 'backups: %s ' "$1" >&2
  IFS= read -r answer || return 1
  printf '%s' "$answer"
}

REPOSITORY="$REPO_FLAG"
[ -n "$REPOSITORY" ] || REPOSITORY=$(old RESTIC_REPOSITORY)
if [ -z "$REPOSITORY" ]; then
  REPOSITORY=$(ask "Where should backups go? (sftp:user@host:/path, s3:https://host/bucket, or a path on a second disk):") || die "nothing was given for the repository, and there is nothing left to read. Run again with --repository <where>. Nothing was changed." "$EX_USAGE"
fi

RECIPIENT="$RECIPIENT_FLAG"
[ -n "$RECIPIENT" ] || RECIPIENT=$(old AGE_SECRETS_RECIPIENT)
if [ -z "$RECIPIENT" ]; then
  RECIPIENT=$(ask "Your PUBLIC age key (starts with age1; the private key stays off this server):") || die "nothing was given for the age key. Run again with --age-recipient <age1...>. Nothing was changed." "$EX_USAGE"
fi

HC="$HC_FLAG"
[ -n "$HC" ] || HC=$(old HC_URL)
if [ -z "$HC" ]; then
  HC=$(ask "The https address of your uptime check (healthchecks.io style):") || die "nothing was given for the uptime check. Run again with --hc-url <https://...>. Nothing was changed." "$EX_USAGE"
fi

# --- 3. refuse unsafe answers, before anything is written ------------------------------------
case "$RECIPIENT" in
  *AGE-SECRET-KEY-*)
    die "that looks like an age PRIVATE key. Never put it on this server: the private key belongs off the server (your own computer and a password manager). Give the public key instead; it starts with age1. Nothing was changed." "$EX_REFUSED" ;;
esac
printf '%s' "$RECIPIENT" | grep -Eq '^age1[0-9a-z]+$' || die "the age key is not a public age key (it must look like age1 followed by letters and digits). Make one with age-keygen on your own machine and give the public line. Nothing was changed." "$EX_REFUSED"

if [ -z "$HC" ]; then die "the uptime check address is empty. The nightly check refuses to run without it. Nothing was changed." "$EX_REFUSED"; fi
printf '%s' "$HC" | grep -Eq '^https://[^/[:space:]]+(/.*)?$' || die "the uptime check address must start with https://. Nothing was changed." "$EX_REFUSED"
case "$HC" in
  *REPLACE-WITH*|*hc-ping.com/UUID*|*example.org*|*example.com*)
    die "the uptime check address is still the example placeholder. Create a check (period 1 day, grace 2 hours) and give its real address. Nothing was changed." "$EX_REFUSED" ;;
esac

# Credentials must never sit inside the repository string.
repo_rest="$REPOSITORY"
case "$repo_rest" in sftp:*) repo_rest="${repo_rest#sftp:}" ;; s3:*) repo_rest="${repo_rest#s3:}" ;; esac
if printf '%s' "$repo_rest" | grep -Eiq '://[^/@]*:[^/@]+@|^[^/@:]+:[^/@]+@|[?&;]?(access[_-]?key|secret|password|token|key)=' ; then
  die "the repository address appears to contain a password or key. Credentials never go in the address: the repository password goes in a file (--password-file) and S3 keys in a root-only file (--s3-credentials-file). Nothing was changed." "$EX_REFUSED"
fi

REPO_KIND=local
case "$REPOSITORY" in
  sftp:*) REPO_KIND=sftp ;;
  s3:*) REPO_KIND=s3 ;;
  /*) REPO_KIND=local ;;
  *) die "the repository must be sftp:..., s3:... or an absolute path on a second disk. Nothing was changed." "$EX_REFUSED" ;;
esac

LOCAL_SAME_DISK=0
if [ "$REPO_KIND" = local ]; then
  anc="$REPOSITORY"
  while [ ! -e "$anc" ] && [ "$anc" != "/" ]; do anc=$(dirname "$anc"); done
  root_dev=$(stat -c %d "$PREFIX" 2>/dev/null || echo root)
  repo_dev=$(stat -c %d "$anc" 2>/dev/null || echo repo)
  [ "$root_dev" = "$repo_dev" ] && LOCAL_SAME_DISK=1
  if [ "$LOCAL_SAME_DISK" = 1 ] && [ "$SAME_MACHINE" != 1 ]; then
    die "that folder is on the same disk as this server. One machine is not a backup: a local path protects against a failed drive or an accidental delete, but not against this server being lost, stolen, seized or destroyed, which is the whole point of a backup living somewhere else. Use an SFTP host or an S3 bucket, or a path on a SECOND disk. If this is only a stopgap, run again with --accept-same-machine. Nothing was changed." "$EX_REFUSED"
  fi
fi

# S3 credentials: from a root-only file, never the command line.
AWS_ID=""; AWS_SECRET=""
if [ "$REPO_KIND" = s3 ]; then
  if [ -n "$S3CRED_FLAG" ]; then
    [ -r "$S3CRED_FLAG" ] || die "cannot read the file given with --s3-credentials-file. Nothing was changed." "$EX_USAGE"
    require_private "$S3CRED_FLAG" "the S3 credentials file"
    AWS_ID=$(env_get "$S3CRED_FLAG" AWS_ACCESS_KEY_ID)
    AWS_SECRET=$(env_get "$S3CRED_FLAG" AWS_SECRET_ACCESS_KEY)
  else
    AWS_ID=$(old AWS_ACCESS_KEY_ID); AWS_SECRET=$(old AWS_SECRET_ACCESS_KEY)
  fi
  [ -n "$AWS_ID" ] && [ -n "$AWS_SECRET" ] || die "an s3: repository needs its key pair: give --s3-credentials-file <path> to a root-only file with AWS_ACCESS_KEY_ID= and AWS_SECRET_ACCESS_KEY= lines. Nothing was changed." "$EX_USAGE"
fi

# --- 4. the repository password -------------------------------------------------------------
GENERATE_PW=0
if [ -n "$PWFILE_FLAG" ]; then
  PW_LOGICAL="$PWFILE_FLAG"
  PW_PHYSICAL=$(P "$PWFILE_FLAG")
else
  PW_LOGICAL=$(old RESTIC_PASSWORD_FILE)
  [ -n "$PW_LOGICAL" ] || PW_LOGICAL="$DEFAULT_PW_LOGICAL"
  PW_PHYSICAL=$(P "$PW_LOGICAL")
fi
if [ -f "$PW_PHYSICAL" ]; then
  require_private "$PW_PHYSICAL" "the password file '$PW_LOGICAL'"
  [ -s "$PW_PHYSICAL" ] || die "the password file '$PW_LOGICAL' is empty. Nothing was changed." "$EX_REFUSED"
elif [ -n "$PWFILE_FLAG" ]; then
  die "cannot read the password file '$PWFILE_FLAG'. Nothing was changed." "$EX_USAGE"
else
  GENERATE_PW=1
  PW_TRY="$WORK/restic-password"
  if [ "$DRY" != 1 ]; then
    [ -r /dev/urandom ] || die "there is no readable /dev/urandom, so no password can be generated safely. Nothing was changed." "$EX_REFUSED"
    head -c 48 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-40 > "$PW_TRY"
    [ "$(wc -c < "$PW_TRY" | tr -d ' ')" -ge 32 ] || die "generating the password failed. Nothing was changed." "$EX_REFUSED"
  fi
fi
PW_FOR_PROBE="$PW_PHYSICAL"
[ "$GENERATE_PW" = 1 ] && PW_FOR_PROBE="$WORK/restic-password"

# --- 5. open the repository, or learn plainly that it is absent ------------------------------
# Exit 10 means "repository does not exist" in newer restic. restic 0.16 (Ubuntu 24.04) has no
# such code; a missing repository there fails with exit 1 and (cmd/restic/global.go at tag
# v0.16.4, OpenRepository):
#   unable to open config file: <backend error>\nIs there a repository at the following location?
# That text is also printed for other Stat failures (for example S3 access denied), so absence
# is accepted only when that text is joined to a backend "not found" error. Anything else,
# including a wrong password, is refused and never initialised.
# run_restic <args>: restic against the chosen repository; S3 keys only in its environment.
run_restic() {
  if [ "$REPO_KIND" = s3 ]; then
    AWS_ACCESS_KEY_ID="$AWS_ID" AWS_SECRET_ACCESS_KEY="$AWS_SECRET" restic -r "$REPOSITORY" "$@"
  else
    restic -r "$REPOSITORY" "$@"
  fi
}
repo_state="" # open | absent
if [ "$GENERATE_PW" = 1 ] && [ "$DRY" = 1 ]; then
  repo_state="unchecked"
else
  probe_out="$WORK/probe.err"
  set +e
  run_restic --password-file "$PW_FOR_PROBE" cat config >/dev/null 2>"$probe_out"
  probe_rc=$?
  set -e
  if [ "$probe_rc" = 0 ]; then
    repo_state=open
  elif [ "$REPO_KIND" = s3 ] && grep -Eiq 'NoSuchBucket|specified bucket|bucket (does not exist|not found)' "$probe_out"; then
    die "the bucket named in that address does not exist (or is not visible to these keys). Restic would create it, so this stops instead: create the bucket first, or check the name in the address. Nothing was changed." "$EX_REFUSED"
  elif [ "$probe_rc" = 10 ]; then
    repo_state=absent
  elif [ "$REPO_KIND" = s3 ] && grep -q 'Is there a repository at the following location' "$probe_out" \
       && grep -Eiq 'NoSuchKey|specified key does not exist|key does not exist' "$probe_out"; then
    repo_state=absent
  elif [ "$REPO_KIND" != s3 ] && grep -q 'Is there a repository at the following location' "$probe_out" \
       && grep -Eiq 'does not exist|no such file|not found|NoSuchKey|no such key' "$probe_out"; then
    repo_state=absent
  elif grep -Eiq 'wrong password|no key found' "$probe_out"; then
    die "a restic repository already exists there, but this password does not open it. Not creating anything over it. Give the right password with --password-file. Nothing was changed." "$EX_REFUSED"
  else
    reason=$(head -c 300 "$probe_out" | tr '\n' ' ')
    die "could not tell whether a repository exists there (restic said: $reason). Not creating anything. Check the address, the network and the credentials, then run this again. Nothing was changed." "$EX_REFUSED"
  fi
fi
if [ "$GENERATE_PW" = 1 ] && [ "$repo_state" = open ]; then
  die "a repository already exists there and cannot be opened with a new password. Give its password with --password-file. Nothing was changed." "$EX_REFUSED"
fi

# --- 6. an existing backup.env must agree with these answers ---------------------------------
want_value() {
  case "$1" in
    LARES_CURRENT_LAYOUT) printf '1' ;;
    RESTIC_REPOSITORY) printf '%s' "$REPOSITORY" ;;
    RESTIC_PASSWORD_FILE) printf '%s' "$PW_LOGICAL" ;;
    AGE_SECRETS_RECIPIENT) printf '%s' "$RECIPIENT" ;;
    HC_URL) printf '%s' "$HC" ;;
    AWS_ACCESS_KEY_ID) printf '%s' "$AWS_ID" ;;
    AWS_SECRET_ACCESS_KEY) printf '%s' "$AWS_SECRET" ;;
  esac
}
ENV_HEADER_1="# $ENV_LOGICAL — written by setup-backups.sh. Root-only (0400)."
ENV_HEADER_2="# See backup.env.example in the engine for what each key does."
# build_env: the new file, in $WORK/backup.env. Settings this command does not manage
# (export lines, comments, other keys) are carried over line by line; lines that cannot be
# carried safely (a value spread over several lines) are listed in $WORK/uncarried.
build_env() {
  : > "$WORK/uncarried"
  {
    echo "$ENV_HEADER_1"
    echo "$ENV_HEADER_2"
    for k in $MANAGED_KEYS; do
      v=$(want_value "$k")
      [ -n "$v" ] || continue
      printf "%s='%s'\n" "$k" "$(printf '%s' "$v" | sed "s/'/'\\\\''/g")"
    done
    if [ "$EXISTING_ENV" = 1 ]; then
      n=0
      while IFS= read -r line || [ -n "$line" ]; do
        n=$((n + 1))
        [ -n "$line" ] || continue
        [ "$line" != "$ENV_HEADER_1" ] && [ "$line" != "$ENV_HEADER_2" ] || continue
        case "$line" in
          \#*) printf '%s\n' "$line"; continue ;;
        esac
        if printf '%s\n' "$line" | grep -Eq '^(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' \
           && printf '%s\n' "$line" | bash -n 2>/dev/null; then
          key=${line#export }; key=${key#"${key%%[![:space:]]*}"}; key=${key%%=*}
          case " $MANAGED_KEYS " in *" $key "*) ;; *) printf '%s\n' "$line" ;; esac
        else
          printf 'line %s\n' "$n" >> "$WORK/uncarried"
        fi
      done < "$ENV_FILE"
    fi
  } > "$WORK/backup.env"
}

differing=""
ENV_UNCHANGED=0
if [ "$EXISTING_ENV" = 1 ]; then
  for k in $MANAGED_KEYS; do
    [ "$(old "$k")" = "$(want_value "$k")" ] || differing="$differing $k"
  done
  build_env
  if cmp -s "$WORK/backup.env" "$ENV_FILE"; then
    ENV_UNCHANGED=1
  elif [ "$RECONFIGURE" != 1 ]; then
    if [ -n "$differing" ]; then
      die "$ENV_LOGICAL already exists and differs from these answers in:$differing. Nothing was changed. If you mean to replace it, run again with --reconfigure." "$EX_REFUSED"
    fi
    die "$ENV_LOGICAL has been edited by hand (comments, other settings or a different layout), and rewriting it would lose that. Nothing was changed. If you mean to rewrite it, run again with --reconfigure; the old file is kept beside it as backup.env.previous." "$EX_REFUSED"
  elif [ -s "$WORK/uncarried" ]; then
    die "$ENV_LOGICAL has lines that cannot be carried over safely ($(tr '\n' ',' < "$WORK/uncarried" | sed 's/,$//')): a value spread over several lines. Nothing was changed. Put each setting on one line and run again." "$EX_REFUSED"
  fi
else
  build_env
fi

# --- 7. confirm a generated password is saved elsewhere --------------------------------------
if [ "$GENERATE_PW" = 1 ] && [ "$DRY" != 1 ]; then
  if [ "$ASSUME_YES" = 1 ]; then
    [ "$PW_SAVED" = 1 ] || die "a repository password has to be generated, and --yes cannot confirm you saved it. Run again with --password-saved once you will keep a copy elsewhere (or give --password-file). Nothing was changed." "$EX_REFUSED"
  else
    echo "backups: A new repository password was generated. WRITE IT DOWN NOW in a password manager: without it every backup is unreadable." >&2
    printf 'backups: password: %s\n' "$(cat "$PW_TRY")" >&2
    printf 'backups: type the word saved once it is stored somewhere other than this server: ' >&2
    ans=""; IFS= read -r ans || ans=""
    [ "$ans" = "saved" ] || die "not confirmed, so nothing was changed." "$EX_REFUSED"
  fi
fi

if [ "$ASSUME_YES" != 1 ] && [ "$DRY" != 1 ]; then
  printf 'backups: switch on backups to %s now? [y/N] ' "$REPOSITORY" >&2
  ans=""; IFS= read -r ans || ans=""
  case "$ans" in y|Y|yes|YES) ;; *) die "not confirmed, so nothing was changed." "$EX_REFUSED" ;; esac
fi

# --- 8. the files ----------------------------------------------------------------------------
SCRIPTS="backup.sh backup-verify.sh restore-drill.sh maintenance-custody.py vault-storage.sh engine-run.sh"
UNITS="lares-backup.service lares-backup.timer lares-backup-verify.service lares-backup-verify.timer lares-restore-drill.service lares-restore-drill.timer"

for f in $SCRIPTS $UNITS; do
  [ -f "$HERE/$f" ] || die "$HERE/$f is missing from this checkout. Nothing was changed." "$EX_REFUSED"
done

# put_file <source> <destination> <mode>: write only when different; .partial then move.
put_file() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then
    chmod "$3" "$2"
    return 0
  fi
  # undo: an existing file that is being replaced is kept beside it as <name>.previous.
  if [ -f "$2" ] && [ "${4:-}" = keep ]; then cp -p "$2" "$2.previous"; fi
  cp "$1" "$2.partial"
  chmod "$3" "$2.partial"
  mv "$2.partial" "$2"
  say "wrote $2"; WROTE="$WROTE $2"
}

# The units are engine files: make sure they point at /opt/lares and the settings file.
fix_unit() { # fix_unit <unit> -> path of a corrected copy in $WORK
  local u="$1" out="$WORK/$1" script
  cp "$HERE/$u" "$out"
  case "$u" in
    lares-backup.service) script=backup.sh ;;
    lares-backup-verify.service) script=backup-verify.sh ;;
    lares-restore-drill.service) script=restore-drill.sh ;;
    *) return 0 ;;
  esac
  if ! grep -qx "ExecStart=/opt/lares/$script" "$out" || ! grep -qx "Environment=AGENT_BOX_BACKUP_ENV=$ENV_LOGICAL" "$out"; then
    say "correcting $u to point at /opt/lares/$script and $ENV_LOGICAL"
    awk -v env="Environment=AGENT_BOX_BACKUP_ENV=$ENV_LOGICAL" -v exe="ExecStart=/opt/lares/$script" '
      /^ExecStart=/ || /^Environment=AGENT_BOX_BACKUP_ENV=/ { next }
      { print }
      /^\[Service\]/ { print env; print exe }
    ' "$HERE/$u" > "$out"
  fi
}

if [ "$DRY" = 1 ]; then
  say "dry run: nothing will be changed. With these answers I would:"
  [ "$GENERATE_PW" = 1 ] && say "  generate a repository password at $PW_LOGICAL (0400) and ask you to confirm it is saved elsewhere"
  say "  write $ENV_LOGICAL (0400) for repository $REPOSITORY"
  say "  copy $SCRIPTS to /opt/lares (0750) and the six units to /etc/systemd/system"
  case "$repo_state" in
    open) say "  reuse the repository that is already there" ;;
    absent) say "  create the repository (restic init)" ;;
    *) say "  open the repository, or create it if it is absent" ;;
  esac
  say "  enable the three timers, then run backup, restore drill and verify once"
  exit "$EX_OK"
fi

mkdir -p "$OPT_LARES" "$SYSTEMD_DIR"
chmod 0750 "$OPT_LARES" 2>/dev/null || true

if [ "$GENERATE_PW" = 1 ]; then
  cp "$PW_TRY" "$PW_PHYSICAL.partial"
  chmod 0400 "$PW_PHYSICAL.partial"
  mv "$PW_PHYSICAL.partial" "$PW_PHYSICAL"
  say "wrote $PW_LOGICAL"; WROTE="$WROTE $PW_LOGICAL"
  if [ "$ASSUME_YES" = 1 ]; then
    say "the generated repository password is in $PW_LOGICAL. Copy it somewhere other than this server now: cat $PW_LOGICAL"
  fi
fi

if [ "$ENV_UNCHANGED" = 1 ]; then
  chmod 0400 "$ENV_FILE"
else
  # undo: with --reconfigure the previous file is kept beside it as backup.env.previous.
  if [ -f "$ENV_FILE" ]; then cp -p "$ENV_FILE" "$ENV_FILE.previous"; chmod 0400 "$ENV_FILE.previous"; fi
  cp "$WORK/backup.env" "$ENV_FILE.partial"
  chmod 0400 "$ENV_FILE.partial"
  mv "$ENV_FILE.partial" "$ENV_FILE"
  say "wrote $ENV_LOGICAL"; WROTE="$WROTE $ENV_LOGICAL"
fi

for s in $SCRIPTS; do put_file "$HERE/$s" "$OPT_LARES/$s" 0750; done
for u in $UNITS; do
  fix_unit "$u"
  put_file "$WORK/$u" "$SYSTEMD_DIR/$u" 0644 keep
done

if [ "$repo_state" = absent ]; then
  say "creating the backup repository (restic init)"
  if ! run_restic --password-file "$PW_PHYSICAL" init; then
    die "creating the repository failed (restic's message is above). This run is only partly done. Already written:${WROTE:- nothing new (everything was already in place)}; the timers are NOT enabled and no job was run. Fix what restic named and run this command again: it is safe to repeat and will not touch what is already right." "$EX_TEMPFAIL"
  fi
else
  say "the backup repository already exists and opens with this password; reusing it"
fi

bash "$HERE/refresh-recovery.sh" --prefix "$PREFIX"
systemctl enable --now lares-backup.timer lares-backup-verify.timer lares-restore-drill.timer
say "the three timers are on (backup 03:00 UTC, check 05:00 UTC, restore rehearsal monthly)"

# --- 9. prove it once ------------------------------------------------------------------------
if [ "$SKIP_FIRST" = 1 ]; then
  say "skipped the first run. Until backup, restore drill and verify have each passed once, this is not proven."
  exit "$EX_OK"
fi

failed=""
for unit in lares-backup.service lares-restore-drill.service lares-backup-verify.service; do
  say "running $unit (this can take a while)"
  if systemctl start "$unit"; then
    say "  $unit: passed"
  else
    say "  $unit: FAILED. Read why with: journalctl -u $unit"
    failed="$failed $unit"
    # Verify needs a passing drill row; later jobs would only repeat the failure.
    [ "$unit" = lares-backup.service ] && break
  fi
done
if [ -n "$failed" ]; then
  echo "backups: NOT protected yet. Failed:$failed. Fix it and run this command again." >&2
  exit "$EX_TEMPFAIL"
fi
if [ "$LOCAL_SAME_DISK" = 1 ]; then
  say "Backups work, but they are NOT off-site: the repository is on this server's own disk, a stopgap. If this server is lost, stolen or destroyed, the backups go with it. Move to an SFTP host or an S3 bucket as soon as you can."
  exit "$EX_OK"
fi
say "Protected: a backup was taken, a restore was rehearsed from it, and the check read it back and pinged your uptime address."
exit "$EX_OK"
