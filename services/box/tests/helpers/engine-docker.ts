// The install.sh tests have no real container to run the box's own programs in, so their
// `docker` stub translates the one kind of call `engine_run` makes into a call on this machine:
//
//   docker run … --entrypoint /app/services/box/node_modules/.bin/tsx <image> /app/services/box/<script> <args>
//
// becomes `<runner> <script> <args>` with the `-e NAME=VALUE` settings exported. The runner is
// the test's own `pnpm` stand-in by default (`pnpm -C <box dir> <program> <args>`, the argv the
// stubs matched before the programs moved into the engine image), or, with runner "tsx", the real renderers from this
// checkout run by this checkout's own tsx against real files (everything else just succeeds).
// That is the translation of `/app/...` to the repository that the image does with its own copy.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const BOX_DIR = join(REPO, "services", "box");

/** A digest-named image, as install.sh requires of the engine image. */
export const ENGINE_IMAGE = `example.invalid/lares-keeper@sha256:${"e".repeat(64)}`;

/** Bash to put at the top of a `docker` stub's body (after its own logging line). */
export function engineDockerPrelude(runner: "pnpm" | "tsx" = "pnpm"): string {
  return `
if [ "\${1:-}" = compose ]; then
  case " $* " in
    *" ps -q db "*) case " $* " in *compose.bootstrap.yaml*) echo bootstrap-container ;; *) echo normal-container ;; esac; exit 0 ;;
  esac
fi
if [ "\${1:-}" = inspect ] && [ "\${2:-}" = bootstrap-container ]; then exit 1; fi
if [ "\${1:-}" = run ]; then
  engine_args=("$@"); engine_at=-1
  for ((i = 0; i < \${#engine_args[@]}; i++)); do
    [ "\${engine_args[i]}" = --entrypoint ] && engine_at=$i
  done
  if [ "$engine_at" -ge 0 ]; then
    for ((i = 0; i < engine_at; i++)); do
      [ "\${engine_args[i]}" = -e ] && export "\${engine_args[i+1]}"
    done
    engine_script="\${engine_args[engine_at+3]#/app/services/box/}"
    engine_rest=("\${engine_args[@]:engine_at+4}")
    # Storage SQL/Git behavior has separate real PostgreSQL+Git coverage. These installer
    # fixtures model only the image command's JSON protocol and root-owned publication.
    if [ "$engine_script" = bin/vault-storage.ts ]; then
      [ "\${STUB_VAULT_FAIL:-}" != "\${engine_rest[0]}" ] || exit 78
      exec python3 - "\${LARES_PREFIX:-}" "\${engine_rest[@]}" <<'PYVAULTFIXTURE'
import json,os,sys
prefix,command=sys.argv[1:3];folder=prefix+'/srv/lares/installation'
for name in ['vault-storage.json','vault-storage.pending.json']:
 path=folder+'/'+name
 if os.path.exists(path):
  print(open(path).read());sys.exit(0)
owner=sys.argv[sys.argv.index('--owner')+1] if '--owner' in sys.argv else 'owner'
private='11111111-1111-4111-8111-111111111111';shared='22222222-2222-4222-8222-222222222222'
print(json.dumps({'version':1,'planId':'33333333-3333-4333-8333-333333333333','organisationId':'example.invalid','provisionerMemberId':owner,'backing':{'id':'44444444-4444-4444-8444-444444444444','kind':'git','root':'/srv'},'areas':[{'areaId':id,'kind':kind,'owner':{'kind':'member' if kind=='private' else 'organisation','id':owner if kind=='private' else 'example.invalid'},'relativePath':'vault/'+kind+'/'+id,'origin':'/var/lib/lares-vault-git/'+id+'.git'} for id,kind in [(private,'private'),(shared,'shared')]]}))
PYVAULTFIXTURE
    fi
    ${
      runner === "tsx"
        ? `case "$engine_script" in
      bin/render-stack.ts|bin/render-keeper-config.ts|bin/render-database-bootstrap.ts) exec node --import tsx/esm "${BOX_DIR}/$engine_script" "\${engine_rest[@]}" ;;
      *) exit 0 ;;
    esac`
        : `case "$engine_script" in
      bin/doctor.ts) exec pnpm -C "${BOX_DIR}" run doctor -- "\${engine_rest[@]}" ;;
      bin/render-database-bootstrap.ts) printf 'services:\n  db: {}\n' > "\${engine_rest[1]}"; exit 0 ;;
      *) engine_name="\${engine_script#bin/}"; exec pnpm -C "${BOX_DIR}" "\${engine_name%.ts}" "\${engine_rest[@]}" ;;
    esac`
    }
  fi
fi
`;
}
