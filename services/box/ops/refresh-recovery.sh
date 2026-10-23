#!/usr/bin/env bash
# Refresh engine recovery programs without changing backup destinations or timer enablement.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
ORIGINAL_ARGS=("$@")
PREFIX="${LARES_PREFIX:-}"
DRY=0
CHECK=0
while [ "$#" -gt 0 ]; do
 case "$1" in --prefix) PREFIX="$2";shift 2;; --dry-run) DRY=1;shift;; --check) CHECK=1;shift;; *) echo 'recovery refresh: unknown argument' >&2;exit 78;; esac
done
PREFIX="${PREFIX%/}"
SCRIPTS='backup.sh export.sh restore.sh backup-verify.sh restore-drill.sh setup-backups.sh maintenance-custody.py vault-storage.sh engine-run.sh refresh-recovery.sh'
UNITS='lares-backup.service lares-backup.timer lares-backup-verify.service lares-backup-verify.timer lares-restore-drill.service lares-restore-drill.timer'
# Validate every ancestor as well as the destination before changing installed files.
python3 - "$PREFIX" <<'PYSAFE'
import os,stat,sys
for path in [sys.argv[1]+'/opt/lares',sys.argv[1]+'/etc/systemd/system']:
 while path and path!='/':
  if os.path.lexists(path) and (stat.S_ISLNK(os.lstat(path).st_mode) or not stat.S_ISDIR(os.lstat(path).st_mode)):
   sys.exit(78)
  if sys.argv[1] and path==sys.argv[1]:break
  path=os.path.dirname(path)
PYSAFE
recovery_content() {
 local name="$1" script=""
 case "$name" in lares-backup.service) script=backup.sh;; lares-backup-verify.service) script=backup-verify.sh;; lares-restore-drill.service) script=restore-drill.sh;; esac
 if [ -z "$script" ] || { grep -qx "ExecStart=/opt/lares/$script" "$HERE/$name" && grep -qx "Environment=AGENT_BOX_BACKUP_ENV=/etc/lares/backup.env" "$HERE/$name"; };then cat "$HERE/$name";return;fi
 awk -v env="Environment=AGENT_BOX_BACKUP_ENV=/etc/lares/backup.env" -v exe="ExecStart=/opt/lares/$script" '
  /^ExecStart=/ || /^Environment=AGENT_BOX_BACKUP_ENV=/ { next }
  { print }
  /^\[Service\]/ { print env; print exe }
 ' "$HERE/$name"
}
# Validate the complete source and every destination before changing any installed file.
for name in $SCRIPTS $UNITS; do
 [ -f "$HERE/$name" ] && [ ! -L "$HERE/$name" ] || { echo 'recovery refresh: incomplete release tooling' >&2;exit 78; }
 case "$name" in *.service|*.timer) to="$PREFIX/etc/systemd/system/$name";; *) to="$PREFIX/opt/lares/$name";; esac
 [ ! -L "$to" ] || { echo 'recovery refresh: symbolic-link destination refused' >&2;exit 78; }
 if [ "$CHECK" = 1 ]; then cmp -s <(recovery_content "$name") "$to" || { echo 'recovery refresh: installed tooling is incomplete or stale' >&2;exit 78; };fi
done
[ "$CHECK" = 1 ] && exit 0
[ "$DRY" != 1 ] || { echo 'recovery refresh: would atomically refresh scripts and units; backup configuration and timer enablement are preserved';exit 0; }
[ "$(id -u)" = 0 ] || [ -n "$PREFIX" ] || { echo 'recovery refresh: root is required' >&2;exit 77; }
RECOVERY_IMAGE="${LARES_ENGINE_IMAGE:-}"
[ -n "$RECOVERY_IMAGE" ] || RECOVERY_IMAGE=$(cat "$HERE/../engine-image" 2>/dev/null || true)
printf '%s' "$RECOVERY_IMAGE" | grep -Eq '^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$' || { echo 'recovery refresh: pinned verifier image unavailable' >&2;exit 78; }
ADMISSION_PREFIX="${PREFIX:-/}"
TEST_OWNER_FLAG=""
[ "${LARES_MAINTENANCE_TESTING:-}" = 1 ] && TEST_OWNER_FLAG=1
if [ "${LARES_MAINTENANCE_ADMITTED:-}" = 1 ]; then
 if [ "$TEST_OWNER_FLAG" = 1 ];then python3 "$HERE/maintenance-custody.py" assert-normal-held "$ADMISSION_PREFIX" refresh-recovery --test-owner || exit 78
 else python3 "$HERE/maintenance-custody.py" assert-normal-held "$ADMISSION_PREFIX" refresh-recovery || exit 78;fi
else
 if [ "$TEST_OWNER_FLAG" = 1 ];then exec python3 "$HERE/maintenance-custody.py" run-normal "$ADMISSION_PREFIX" refresh-recovery --test-owner -- "${ORIGINAL_ARGS[@]}"
 else exec python3 "$HERE/maintenance-custody.py" run-normal "$ADMISSION_PREFIX" refresh-recovery -- "${ORIGINAL_ARGS[@]}";fi
fi
mkdir -p "$PREFIX/opt/lares" "$PREFIX/etc/systemd/system"
for name in $SCRIPTS $UNITS; do
 case "$name" in *.service|*.timer) to="$PREFIX/etc/systemd/system/$name";mode=0644;; *) to="$PREFIX/opt/lares/$name";mode=0750;; esac
 if [ -f "$to" ] && cmp -s <(recovery_content "$name") "$to";then continue;fi
 tmp=$(mktemp "$to.partial.XXXXXX")
 recovery_content "$name" > "$tmp";chmod "$mode" "$tmp"
 if [ "$(id -u)" = 0 ];then chown 0:10001 "$tmp";fi
 mv "$tmp" "$to"
done
python3 - "$PREFIX" "$RECOVERY_IMAGE" $SCRIPTS $UNITS <<'PY'
import hashlib,json,os,sys,tempfile
prefix=sys.argv[1];image=sys.argv[2];files={}
for name in sys.argv[3:]:
 path=prefix+('/etc/systemd/system/' if name.endswith(('.service','.timer')) else '/opt/lares/')+name
 files[name]=hashlib.sha256(open(path,'rb').read()).hexdigest()
def publish(path,content):
 if os.path.exists(path) and open(path).read()==content:return
 fd,tmp=tempfile.mkstemp(prefix='.vault-recovery.',dir=os.path.dirname(path))
 with os.fdopen(fd,'w') as f:f.write(content);f.flush();os.fsync(f.fileno())
 os.chmod(tmp,0o640)
 if os.getuid()==0:os.chown(tmp,0,10001)
 os.replace(tmp,path)
publish(prefix+'/opt/lares/vault-recovery.json',json.dumps({'version':1,'engineImage':image,'files':files})+'\n')
publish(prefix+'/opt/lares/vault-recovery-engine-image',image+'\n')
PY
systemctl daemon-reload
if [ ! -f "$PREFIX/etc/lares/backup.env" ];then echo 'recovery refresh: backups remain off until a destination is configured and proved with lares backups';fi
