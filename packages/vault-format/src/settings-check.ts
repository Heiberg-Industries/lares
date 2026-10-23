// One plain sentence per missing setting.
//
// `settings.ts` says what a setting is FOR and what breaks without it. Nobody yet turns
// that into something a non-developer owner can read when the installation will not start. This
// file is that translation, and nothing else: no process.env, no fs, no I/O at module scope, so
// the SAME function can be called at container startup and by `lares doctor`
// with no real environment and no real files in either case.
//
// A `*_FILE` setting names a PATH, never a value (`SettingDef.secret` is false for every `_FILE`
// name — see settings.ts). The path itself is safe to show an owner; the file's CONTENTS never
// are. So the only thing this module is ever told about a secret file is basic metadata — whether
// it exists, can be read, is empty, and (when needed) whether it is a regular file or socket —
// from an injected `ProbeFile`. It never receives, and therefore can never leak, the bytes inside.
import type { SettingReader } from "./settings.js";
import { requiredNamesFor, settingByName } from "./settings.js";

/** What is true of a file or socket, and nothing else. Never the file's contents. */
export interface FileProbe {
  readonly exists: boolean;
  readonly readable: boolean;
  readonly empty: boolean;
  /** Present only when the caller can distinguish filesystem object type. */
  readonly isSocket?: boolean;
  readonly isFile?: boolean;
}

/** Given a path, reports basic file/socket metadata. Injected so a
 *  caller with no real files (a unit test) and a caller with real ones (startup, `lares doctor`)
 *  can share this module's logic. */
export type ProbeFile = (path: string) => FileProbe;

export interface SettingProblem {
  readonly name: string;
  readonly reader: SettingReader;
  readonly kind: "missing" | "blank" | "unreadable" | "empty";
  /** The whole sentence a person reads. Never contains a value. */
  readonly say: string;
}

const WHERE = "Set it in the installation's settings and start it again.";
const WHERE_SECRET_FILE = "Put the secret in a file at that path, readable by the agent, and start it again.";
const MANAGED_MODEL_PURPOSE_SOCKET = "/run/lares/model-purpose/model-purpose.sock";
const MANAGED_MODEL_PURPOSE_GATEWAY_SOCKET = "/run/lares/model-purpose/gateway.sock";
const MANAGED_RUNTIME_CONTROL_FILE = "/run/secrets/runtime-control";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHELL_UUID_PATTERN = `${"[0123456789abcdef]".repeat(8)}-${"[0123456789abcdef]".repeat(4)}-[1-8]${"[0123456789abcdef]".repeat(3)}-[89ab]${"[0123456789abcdef]".repeat(3)}-${"[0123456789abcdef]".repeat(12)}`;

function hasManagedChiefTransport(env: NodeJS.ProcessEnv, probeFile: ProbeFile): boolean {
  if (env.GATEWAY_KEY_FILE !== undefined || env.LARES_MODEL_PURPOSE_RUNTIME_SOCKET !== MANAGED_MODEL_PURPOSE_SOCKET || !UUID.test(env.LARES_AGENT_INCARNATION ?? "") || env.LARES_RUNTIME_CONTROL_SECRET_FILE !== MANAGED_RUNTIME_CONTROL_FILE) return false;
  const runtime = probeFile(MANAGED_MODEL_PURPOSE_SOCKET);
  const gateway = probeFile(MANAGED_MODEL_PURPOSE_GATEWAY_SOCKET);
  const control = probeFile(MANAGED_RUNTIME_CONTROL_FILE);
  return runtime.exists && runtime.isSocket === true
    && gateway.exists && gateway.isSocket === true
    && control.exists && control.readable && !control.empty && control.isFile === true;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/** Escapes a sentence for use inside a double-quoted POSIX shell string. */
function shellEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

function sentenceFor(
  name: string,
  breaksWithout: string,
  kind: SettingProblem["kind"],
  path?: string,
): string {
  const where = path !== undefined ? ` (\`${path}\`)` : "";
  switch (kind) {
    case "missing":
      return `  - \`${name}\` is not set. ${breaksWithout} ${WHERE}`;
    case "blank":
      return `  - \`${name}\` is set to nothing, which counts as not set. ${breaksWithout} ${WHERE}`;
    case "unreadable":
      return `  - \`${name}\` points to a file that does not exist or cannot be read${where}. ${breaksWithout} ${WHERE_SECRET_FILE}`;
    case "empty":
      return `  - \`${name}\` points to a file that exists but is empty${where}. ${breaksWithout} ${WHERE_SECRET_FILE}`;
  }
}

/** Every required setting `reader` is missing, blank, or (for a `*_FILE` setting) points at a
 *  file that cannot be read or has nothing in it — in declaration order, so the setting that
 *  stops everything (the database URL) is always first. An OPTIONAL setting is never reported:
 *  this only walks `requiredNamesFor(reader)`. */
export function checkSettings(
  reader: SettingReader,
  env: NodeJS.ProcessEnv,
  probeFile: ProbeFile,
): SettingProblem[] {
  const problems: SettingProblem[] = [];
  const managedChiefTransport = reader === "chief-of-staff" && hasManagedChiefTransport(env, probeFile);
  for (const name of requiredNamesFor(reader)) {
    const def = settingByName(name);
    if (!def) continue; // settings.ts guarantees every required name is declared; defensive only
    const value = env[name];
    if (name === "GATEWAY_KEY_FILE" && managedChiefTransport) continue;
    if (isBlank(value)) {
      const kind: SettingProblem["kind"] = value === undefined ? "missing" : "blank";
      problems.push({ name, reader, kind, say: sentenceFor(name, def.breaksWithout, kind) });
      continue;
    }
    if (name.endsWith("_FILE")) {
      const path = value!.trim();
      const probe = probeFile(path);
      if (!probe.exists || !probe.readable) {
        problems.push({
          name,
          reader,
          kind: "unreadable",
          say: sentenceFor(name, def.breaksWithout, "unreadable", path),
        });
      } else if (probe.empty) {
        problems.push({
          name,
          reader,
          kind: "empty",
          say: sentenceFor(name, def.breaksWithout, "empty", path),
        });
      }
    }
  }
  return problems;
}

/** One block: a line per problem, then what to do. Empty string when there are none. */
export function settingsReport(problems: readonly SettingProblem[]): string {
  if (problems.length === 0) return "";
  return [
    "This installation cannot start:",
    ...problems.map((p) => p.say),
    "Set them in the installation's settings and start it again. `lares doctor` lists all of them.",
  ].join("\n");
}

/** The committed shell fragment's body: one `lares_require NAME "sentence"` — or, for a `*_FILE`
 *  name, one `lares_require_file NAME "sentence"` — per name required by any of `readers`, union
 *  in first-seen order, never a value echoed. A NAME, a sentence already vetted as owner-readable
 *  in `settings.ts`, and for a `*_FILE` setting the PATH it points at, which is a setting's value
 *  the owner chose, never a secret's contents. Pure POSIX sh (the runtime image is
 *  node:24-bookworm-slim, where `/bin/sh` is dash): no `declare -A`, no `${x^^}`, no `mapfile`.
 *
 *  `lares_require_file` is the shell's half of what `checkSettings` does in TypeScript, in the
 *  same order and with the same three verdicts — blank, then not readable, then empty — because
 *  there is no TypeScript loader in the runtime image before `eve start`: the image never runs
 *  `pnpm install` or a build, so a `.ts` file cannot run there. Both halves are generated from
 *  `SETTINGS`, so neither can quietly grow a name the other does not have. */
export interface RequiredSettingsShellOptions {
  /** Permits the exact fixed model-purpose transport for the chief image only. */
  readonly managedChiefModelPurpose?: boolean;
}

export function requiredSettingsShell(readers: readonly SettingReader[], options: RequiredSettingsShellOptions = {}): string {
  if (options.managedChiefModelPurpose && (readers.length !== 1 || readers[0] !== "chief-of-staff"))
    throw new Error("Managed model-purpose startup guard is only valid for the chief-of-staff reader");
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const reader of readers) {
    for (const name of requiredNamesFor(reader)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const def = settingByName(name);
      if (!def) continue;
      const check = name.endsWith("_FILE") ? "lares_require_file" : "lares_require";
      lines.push(`${check} ${name} "${shellEscape(def.breaksWithout)}"`);
    }
  }
  return [
    "#!/bin/sh",
    "# Generated by packages/agent-kit/bin/generate-settings.ts — never hand-edited.",
    "# Refuses to start when a required setting is missing or blank, or when a setting that names",
    "# a secret FILE points at one that cannot be read or has nothing in it. Never echoes a value —",
    "# only the setting's NAME, its already-committed sentence, and for a file the PATH.",
    "set -eu",
    "missing=0",
    'lares_require() { eval "v=\\${$1-}"; [ -n "${v#"${v%%[![:space:]]*}"}" ] || { echo "lares: $1 is not set. $2" >&2; missing=1; }; }',
    'lares_require_file() { eval "p=\\${$1-}"; [ -n "${p#"${p%%[![:space:]]*}"}" ] || { echo "lares: $1 is not set. $2" >&2; missing=1; return; }; [ -r "$p" ] || { echo "lares: $1 points to a file that does not exist or cannot be read ($p). $2" >&2; missing=1; return; }; [ -s "$p" ] || { echo "lares: $1 points to a file that exists but is empty ($p). $2" >&2; missing=1; }; }',
    ...lines.filter((line) => !(options.managedChiefModelPurpose && line.startsWith("lares_require_file GATEWAY_KEY_FILE "))),
    ...(options.managedChiefModelPurpose ? [
      'if [ "${GATEWAY_KEY_FILE+x}" = x ]; then',
      ...lines.filter((line) => line.startsWith("lares_require_file GATEWAY_KEY_FILE ")).map((line) => `  ${line}`),
      'else',
      '  [ "${LARES_MODEL_PURPOSE_RUNTIME_SOCKET-}" = "/run/lares/model-purpose/model-purpose.sock" ] || { echo "lares: managed model-purpose socket is not configured" >&2; missing=1; }',
      `  case "\${LARES_AGENT_INCARNATION-}" in ${SHELL_UUID_PATTERN}) ;; *) echo "lares: managed incarnation is invalid" >&2; missing=1 ;; esac`,
      '  [ "${LARES_RUNTIME_CONTROL_SECRET_FILE-}" = "/run/secrets/runtime-control" ] && [ -f "/run/secrets/runtime-control" ] && [ -r "/run/secrets/runtime-control" ] && [ -s "/run/secrets/runtime-control" ] || { echo "lares: runtime-control file is missing, unreadable, or empty" >&2; missing=1; }',
      '  [ -S "/run/lares/model-purpose/model-purpose.sock" ] || { echo "lares: model-purpose runtime socket is unavailable" >&2; missing=1; }',
      '  [ -S "/run/lares/model-purpose/gateway.sock" ] || { echo "lares: model-purpose gateway socket is unavailable" >&2; missing=1; }',
      'fi',
    ] : []),
    '[ "$missing" -eq 0 ] || exit 1',
    "",
  ].join("\n");
}
