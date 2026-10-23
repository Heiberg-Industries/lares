#!/bin/sh
# Keeper startup admission primitive; CI proves the generated production Compose path.
set -eu
refuse() { printf '%s\n' 'maintenance admission refused' >&2; exit 78; }

[ "$#" -ge 5 ] || refuse
directory=$1
installation_id=$2
epoch=$3
shift 3
[ "$1" = -- ] || refuse
shift
[ "$#" -gt 0 ] || refuse
case "$directory" in /*) ;; *) refuse ;; esac
[ -d "$directory" ] && [ ! -L "$directory" ] || refuse

# Keeper starts from /app so its fixed relative workspace command resolves after admission.
# Record the physical caller directory before pinning custody; fail closed if it cannot be
# restored after the checks.
caller_directory=$(pwd -P 2>/dev/null) || refuse
case "$caller_directory" in /*) ;; *) refuse ;; esac

# Pin the working directory first. All subsequent lock and intent operations are relative to
# this directory descriptor, so replacing a path component cannot redirect an open/read.
cd "$directory" 2>/dev/null || refuse
validate_ancestry() {
  node - "$directory" <<'NODE' || refuse
const fs = require('node:fs');
const path = require('node:path');
try {
  const supplied = process.argv[2];
  if (!path.isAbsolute(supplied) || path.resolve(supplied) !== process.cwd()) process.exit(1);
  const parts = supplied.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) process.exit(1);
  let current = '';
  for (let index = 0; index < Math.max(parts.length, 1); index++) {
    current += '/' + (parts[index] ?? '');
    const info = fs.lstatSync(current);
    const mode = info.mode & 0o7777;
    if (!info.isDirectory() || info.isSymbolicLink()) process.exit(1);
    if (index === parts.length - 1) {
      if (info.uid !== 0 || mode !== 0o755) process.exit(1);
    } else if (info.uid !== 0 || ((mode & 0o022) !== 0 &&
        !(mode === 0o1777 && ['/tmp', '/var/tmp', '/private/tmp'].includes(current)))) {
      process.exit(1);
    }
  }
} catch { process.exit(1); }
NODE
}
validate_ancestry
[ "$(stat -c '%u:%a' . 2>/dev/null)" = 0:755 ] || refuse

# Open relative to the pinned directory. Check both descriptor and directory-relative name
# before and after flock; intent is also read relative to this same pinned working directory.
[ -f ./service-gate.lock ] && [ ! -L ./service-gate.lock ] || refuse
[ "$(stat -c '%u:%a:%h' ./service-gate.lock 2>/dev/null)" = 0:444:1 ] || refuse
[ -f ./intent.json ] && [ ! -L ./intent.json ] || refuse
[ "$(stat -c '%u:%a:%h' ./intent.json 2>/dev/null)" = 0:444:1 ] || refuse
exec 9<./service-gate.lock || refuse
before=$(stat -Lc '%d:%i:%h:%u:%a' /proc/$$/fd/9 2>/dev/null) || refuse
path_before=$(stat -c '%d:%i:%h:%u:%a' ./service-gate.lock 2>/dev/null) || refuse
[ "$before" = "$path_before" ] || refuse
flock --shared --nonblock 9 || refuse
after=$(stat -Lc '%d:%i:%h:%u:%a' /proc/$$/fd/9 2>/dev/null) || refuse
path_after=$(stat -c '%d:%i:%h:%u:%a' ./service-gate.lock 2>/dev/null) || refuse
[ "$after" = "$path_after" ] || refuse
validate_ancestry

# Check the immutable intent through the pinned working directory with one bounded no-follow read.
node - "$installation_id" "$epoch" <<'NODE' || refuse
const fs = require('node:fs');
try {
  const id = process.argv[2], epochText = process.argv[3], epoch = Number(epochText);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
      !Number.isSafeInteger(epoch) || epoch < 1 || epoch > 2147483647 || String(epoch) !== epochText) process.exit(1);
  const fd = fs.openSync('intent.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd), named = fs.lstatSync('intent.json');
    if (!before.isFile() || named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino ||
        before.uid !== 0 || (before.mode & 0o7777) !== 0o444 || before.nlink !== 1 || before.size > 256) process.exit(1);
    const bytes = Buffer.alloc(257), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (count > 256 || count !== before.size || before.dev !== after.dev || before.ino !== after.ino || after.size > 256) process.exit(1);
    const raw = bytes.subarray(0, count).toString('utf8');
    const value = JSON.parse(raw);
    const keys = Object.keys(value).sort().join(',');
    const expected = '{"epoch":' + epoch + ',"installationId":' + JSON.stringify(id) +
      ',"state":"normal","version":1}\n';
    if (keys !== 'epoch,installationId,state,version' || raw !== expected || value.version !== 1 ||
        value.installationId !== id || value.epoch !== epoch || value.state !== 'normal') process.exit(1);
  } finally { fs.closeSync(fd); }
} catch { process.exit(1); }
NODE

# The same open-file-description remains held across exec. Only explicit participants retaining
# this descriptor are covered; arbitrary descendants are not certified by this primitive.
cd "$caller_directory" 2>/dev/null || refuse
[ "$(pwd -P 2>/dev/null)" = "$caller_directory" ] || refuse
exec "$@"
