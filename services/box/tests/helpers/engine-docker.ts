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
    ${
      runner === "tsx"
        ? `case "$engine_script" in
      bin/render-stack.ts|bin/render-keeper-config.ts) exec "${BOX_DIR}/node_modules/.bin/tsx" "${BOX_DIR}/$engine_script" "\${engine_rest[@]}" ;;
      *) exit 0 ;;
    esac`
        : `case "$engine_script" in
      bin/doctor.ts) exec pnpm -C "${BOX_DIR}" run doctor -- "\${engine_rest[@]}" ;;
      *) engine_name="\${engine_script#bin/}"; exec pnpm -C "${BOX_DIR}" "\${engine_name%.ts}" "\${engine_rest[@]}" ;;
    esac`
    }
  fi
fi
`;
}
