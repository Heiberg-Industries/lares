# shellcheck shell=bash
# Fixed managed Vault inventory shared by backup/export/recovery. No arbitrary path input.
# No Git or Node is required on the host. Git/DB verification runs in the pinned engine.
VAULT_STORAGE_PATHS=()
VAULT_STORAGE_REPOSITORIES=()
VAULT_STORAGE_LOCKS=""
VAULT_STORAGE_PRESENT=0

vault_storage_load() { # physical prefix (empty on the installed host)
  local prefix="${1%/}" records tag value
  VAULT_STORAGE_PATHS=(); VAULT_STORAGE_REPOSITORIES=(); VAULT_STORAGE_PRESENT=0
  records=$(python3 - "$prefix" <<'PY'
import json,os,re,stat,sys
prefix=sys.argv[1]
def p(path): return prefix+path
def regular(path):
 s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: raise ValueError()
def directory(path):
 if not stat.S_ISDIR(os.lstat(path).st_mode) or os.path.realpath(path)!=os.path.abspath(path): raise ValueError()
def exact(value,keys):
 if not isinstance(value,dict) or set(value)!=set(keys): raise ValueError()
def ident(value):
 if not isinstance(value,str) or not value or len(value)>200 or any(ord(c)<32 or ord(c)==127 for c in value): raise ValueError()
def opaque(value):
 if not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',value): raise ValueError()
roots=['/srv/vault','/var/lib/lares-vault-git']
manifest='/srv/lares/installation/vault-storage.json'
pending='/srv/lares/installation/vault-storage.pending.json'
try:
 present=[os.path.lexists(p(v)) for v in roots+[manifest]]
 if not any(present):
  if os.path.lexists(p(pending)): raise ValueError()
  sys.exit(0)
 if not all(present) or os.path.lexists(p(pending)): raise ValueError()
 for root in roots: directory(p(root))
 regular(p(manifest))
 inv=json.load(open(p(manifest)))
 exact(inv,['version','planId','organisationId','provisionerMemberId','backing','areas'])
 if inv['version']!=1: raise ValueError()
 opaque(inv['planId']);ident(inv['organisationId']);ident(inv['provisionerMemberId'])
 exact(inv['backing'],['id','kind','root']);opaque(inv['backing']['id'])
 if inv['backing']['kind']!='git' or inv['backing']['root']!='/srv': raise ValueError()
 if not isinstance(inv['areas'],list) or not inv['areas']: raise ValueError()
 ids=set();expected={'private':set(),'shared':set()}
 for area in inv['areas']:
  exact(area,['areaId','kind','owner','relativePath','origin']);opaque(area['areaId'])
  if area['areaId'] in ids or area['kind'] not in expected: raise ValueError()
  ids.add(area['areaId']);expected[area['kind']].add(area['areaId'])
  exact(area['owner'],['kind','id']);ident(area['owner']['id'])
  if area['owner']['kind']!=('member' if area['kind']=='private' else 'organisation'): raise ValueError()
  if area['kind']=='shared' and area['owner']['id']!=inv['organisationId']: raise ValueError()
  relative='vault/'+area['kind']+'/'+area['areaId'];origin='/var/lib/lares-vault-git/'+area['areaId']+'.git'
  if area['relativePath']!=relative or area['origin']!=origin: raise ValueError()
  work=p('/srv/'+relative);bare=p(origin);directory(work);directory(bare);directory(work+'/.git')
  marker=work+'/.lares-vault-area.json';regular(marker)
  wanted={'version':1,'areaId':area['areaId'],'backingStoreId':inv['backing']['id'],'relativePath':relative,'kind':area['kind'],'owner':area['owner']}
  if json.load(open(marker))!=wanted: raise ValueError()
  allowed_repositories={work,work+'/.git',bare}
  for tree in [work,bare]:
   for base,dirs,files in os.walk(tree,followlinks=False):
    present=lambda name:os.path.lexists(os.path.join(base,name))
    bare_repository=present('HEAD') and present('objects') and (present('refs') or present('packed-refs') or present('config'))
    if (present('.git') and base+'/.git' not in allowed_repositories) or (bare_repository and base not in allowed_repositories):raise ValueError()
    for name in dirs+files:
     st=os.lstat(os.path.join(base,name))
     if stat.S_ISLNK(st.st_mode) or not(stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)) or (stat.S_ISREG(st.st_mode) and st.st_nlink!=1): raise ValueError()
  if os.path.lexists(work+'/.git/objects/info/alternates') or os.path.lexists(bare+'/objects/info/alternates'): raise ValueError()
  print('R\t'+work)
 if set(os.listdir(p('/srv/vault')))-{'private','shared'}: raise ValueError()
 for kind,children in expected.items():
  folder=p('/srv/vault/'+kind);directory(folder)
  if set(os.listdir(folder))!=children: raise ValueError()
 if set(os.listdir(p('/var/lib/lares-vault-git')))!={v+'.git' for v in ids}: raise ValueError()
 for root in roots: print('P\t'+p(root))
except Exception:
 print('vault storage: incomplete or conflicting managed storage; recovery refused',file=sys.stderr)
 sys.exit(1)
PY
  ) || return 1
  [ -n "$records" ] || return 0
  VAULT_STORAGE_PRESENT=1
  while IFS=$'\t' read -r tag value; do
    case "$tag" in P) VAULT_STORAGE_PATHS+=("$value") ;; R) VAULT_STORAGE_REPOSITORIES+=("$value") ;; *) return 1 ;; esac
  done <<< "$records"
}

vault_storage_lock() {
  [ "$VAULT_STORAGE_PRESENT" = 1 ] || return 0
  VAULT_STORAGE_LOCKS=$(python3 - "${VAULT_STORAGE_REPOSITORIES[@]}" <<'PY'
import os,sys,time,uuid
owned=[];token=uuid.uuid4().hex
try:
 for root in sorted(sys.argv[1:]):
  lock=os.path.realpath(root+'/.git')+'/lares-vault.lock';deadline=time.monotonic()+30
  while True:
   try:
    fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f:f.write(token)
    owned.append(lock);break
   except FileExistsError:
    if time.monotonic()>deadline:raise ValueError()
    time.sleep(.025)
 for lock in owned:print(lock+'\t'+token)
except Exception:
 for lock in owned:os.unlink(lock)
 print('vault storage: repository lock did not clear; snapshot refused. Check the writer before explicit stale-lock recovery.',file=sys.stderr);sys.exit(1)
PY
  )
}

vault_storage_unlock() {
  [ -n "${VAULT_STORAGE_LOCKS:-}" ] || return 0
  python3 - "$VAULT_STORAGE_LOCKS" <<'PY'
import os,sys
for entry in sys.argv[1].splitlines():
 path,token=entry.split('\t')
 try:
  if open(path).read()==token:os.unlink(path)
 except FileNotFoundError:pass
PY
  local rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  VAULT_STORAGE_LOCKS=""
}

# Invoke the verifier from the digest-pinned keeper image. The logical Git origin URL
# stays unchanged in snapshots; only trusted physical file lookup is scratch-prefixed.
vault_storage_verify() { # prefix, database, mode: verify|verify-files|verify-empty
  local prefix="${1%/}" database="$2" mode="${3:-verify}" path
  if [ "$VAULT_STORAGE_PRESENT" != 1 ]; then
    [ "$mode" != verify-files ] || return 0
    [ -r "${LARES_PREFIX:-}/opt/lares/vault-recovery-engine-image" ] || return 0
  fi
  local ops="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local BOX_DIR ENGINE_IMAGE LARES_ENGINE_IMAGE="${LARES_ENGINE_IMAGE:-}"
  . "$ops/engine-run.sh"
  [ ! -r "${LARES_PREFIX:-}/opt/lares/vault-recovery-engine-image" ] || LARES_ENGINE_IMAGE=$(cat "${LARES_PREFIX:-}/opt/lares/vault-recovery-engine-image")
  BOX_DIR="${LARES_ENGINE_BOX_DIR:-${LARES_PREFIX:-}/opt/lares/current/services/box}"
  engine_resolve_image "" || { echo 'vault storage: pinned recovery engine unavailable' >&2; return 1; }
  local -a mounts=(--runtime-user)
  [ "$VAULT_STORAGE_PRESENT" != 1 ] || mounts+=(--ro "$prefix/srv/lares/installation/vault-storage.json")
  for path in "${VAULT_STORAGE_REPOSITORIES[@]}"; do mounts+=(--ro "$path"); done
  # Bare paths are a fixed inventory, not discovered from arbitrary directories.
  if [ "$VAULT_STORAGE_PRESENT" = 1 ]; then for path in "$prefix"/var/lib/lares-vault-git/*.git; do mounts+=(--ro "$path"); done;fi
  local database_password_file="${LARES_PREFIX:-}/etc/lares/secrets/database-password"
  if [ "$mode" != verify-files ]; then mounts+=(--ro "$database_password_file" --env "DATABASE_PASSWORD_FILE=$database_password_file"); fi
  engine_run "${mounts[@]}" --env "PGHOST=${PGHOST:-127.0.0.1}" --env "PGPORT=${PGPORT:-5432}" \
    --env "PGUSER=lares_app" --env "PGDATABASE=$database" bin/vault-storage.ts "$mode" --prefix "$prefix"
}

# Root publishes a plan before creating only its new fixed-layout directories. Existing
# nonempty data/permissions are never recursively changed or implicitly adopted.
vault_storage_prepare() { # prefix, JSON produced by the trusted preview command
 python3 - "${1%/}" "$2" <<'PY'
import json,os,re,stat,sys,tempfile
prefix=sys.argv[1];inv=json.loads(sys.argv[2])
def p(v):return prefix+v
def safe(path):
 cursor=path
 while cursor and cursor!='/':
  if os.path.lexists(cursor) and stat.S_ISLNK(os.lstat(cursor).st_mode):raise ValueError()
  if prefix and cursor==prefix:break
  cursor=os.path.dirname(cursor)
def ensure(path,uid,gid,mode):
 safe(path)
 if not os.path.exists(path):
  parent=os.path.dirname(path)
  if not os.path.exists(parent):ensure(parent,0,10001,0o750)
  os.mkdir(path,mode);os.chmod(path,mode);os.chown(path,uid,gid) if os.getuid()==0 else None
 elif not stat.S_ISDIR(os.lstat(path).st_mode):raise ValueError()
def atomic(path,value):
 fd,tmp=tempfile.mkstemp(prefix='.vault-plan.',dir=os.path.dirname(path))
 try:
  with os.fdopen(fd,'w') as f:json.dump(value,f);f.write('\n');f.flush();os.fsync(f.fileno())
  os.chmod(tmp,0o640)
  if os.getuid()==0:os.chown(tmp,0,10001)
  os.link(tmp,path)
  directory_fd=os.open(os.path.dirname(path),os.O_RDONLY)
  try:os.fsync(directory_fd)
  finally:os.close(directory_fd)
 finally:os.unlink(tmp)
try:
 if inv['version']!=1 or inv['backing']['root']!='/srv' or inv['backing']['kind']!='git':raise ValueError()
 paths=[]
 for a in inv['areas']:
  if not re.fullmatch(r'[a-f0-9-]{36}',a['areaId']) or a['kind'] not in ('private','shared') or a['relativePath']!='vault/'+a['kind']+'/'+a['areaId'] or a['origin']!='/var/lib/lares-vault-git/'+a['areaId']+'.git':raise ValueError()
  paths += [p('/srv/'+a['relativePath']),p(a['origin'])]
 folder=p('/srv/lares/installation');ensure(folder,0,10001,0o750)
 if os.getuid()==0:
  st=os.stat(folder);bits=(st.st_mode>>(6 if st.st_uid==10001 else 3 if st.st_gid==10001 else 0))&7
  if bits&5!=5:raise ValueError()
 ready=folder+'/vault-storage.json';pending=folder+'/vault-storage.pending.json'
 for path in [ready,pending]:
  safe(path)
  if os.path.lexists(path):
   st=os.lstat(path)
   if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or json.load(open(path))!=inv:raise ValueError()
 if not os.path.exists(ready) and not os.path.exists(pending):atomic(pending,inv)
 for path in paths:
  ensure(path,10001,10001,0o700)
  if not os.listdir(path) and os.getuid()==0:os.chown(path,10001,10001);os.chmod(path,0o700)
 for kind in ['private','shared']:ensure(p('/srv/vault/'+kind),0,10001,0o750)
except Exception:
 print('vault storage: root preparation refused; keep the pending plan for review',file=sys.stderr);sys.exit(1)
PY
}

vault_storage_publish() { # prefix, verified JSON after the database commit
 python3 - "${1%/}" "$2" <<'PY'
import json,os,stat,sys,tempfile
folder=sys.argv[1]+'/srv/lares/installation';inv=json.loads(sys.argv[2]);ready=folder+'/vault-storage.json';pending=folder+'/vault-storage.pending.json'
try:
 for path in [ready,pending]:
  if os.path.lexists(path):
   st=os.lstat(path)
   if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or json.load(open(path))!=inv:raise ValueError()
 if not os.path.exists(ready):
  if not os.path.exists(pending):raise ValueError()
  fd,tmp=tempfile.mkstemp(prefix='.vault-ready.',dir=folder)
  try:
   with os.fdopen(fd,'w') as f:json.dump(inv,f);f.write('\n');f.flush();os.fsync(f.fileno())
   os.chmod(tmp,0o640)
   if os.getuid()==0:os.chown(tmp,0,10001)
   os.link(tmp,ready)
  finally:os.unlink(tmp)
 if os.path.exists(pending):os.unlink(pending)
 directory_fd=os.open(folder,os.O_RDONLY)
 try:os.fsync(directory_fd)
 finally:os.close(directory_fd)
except Exception:
 print('vault storage: verified inventory was not published; retry the same plan',file=sys.stderr);sys.exit(1)
PY
}

# Called only after verify-empty has checked the target DB and both repositories, while
# the snapshot holds their canonical locks and services are stopped. Stage exact paths;
# never glob-delete a parent or classify arbitrary data as bootstrap.
vault_storage_stage_empty() { # target prefix, private restore scratch
 python3 - "${1%/}" "$2" "${VAULT_STORAGE_LOCKS:-}" <<'PY'
import json,os,shutil,sys
prefix,scratch,locks=sys.argv[1:];folder=prefix+'/srv/lares/installation';file=folder+'/vault-storage.json'
if not os.path.exists(file):sys.exit(0)
inv=json.load(open(file));stage=scratch+'/target-empty-vault';os.mkdir(stage,0o700)
tokens=dict(line.split('\t') for line in locks.splitlines())
for area in inv['areas']:
 source=prefix+'/srv/'+area['relativePath'];destination=stage+'/'+area['areaId']+'-working';old=os.path.realpath(source+'/.git')+'/lares-vault.lock'
 shutil.move(source,destination)
 lock=destination+'/.git/lares-vault.lock'
 if os.path.exists(lock) and open(lock).read()==tokens.get(old):os.unlink(lock)
 shutil.move(prefix+area['origin'],stage+'/'+area['areaId']+'-bare.git')
shutil.move(file,stage+'/vault-storage.json')
for path in ['/srv/vault/private','/srv/vault/shared','/srv/vault','/var/lib/lares-vault-git']:os.rmdir(prefix+path)
PY
}
