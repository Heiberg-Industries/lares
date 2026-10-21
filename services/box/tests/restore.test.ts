// restore.sh puts an installation back from a nightly restic snapshot onto a fresh server
// (docs/install.md, "Restoring onto a new server"). These tests drive it with logging stubs
// on PATH (restic, docker, pnpm, id, df) and a temporary prefix, the same pattern as
// tests/setup-backups.test.ts. Nothing here touches a real repository, Docker or Postgres.
//
// The properties that matter most are about what does NOT happen: every refusal must leave
// the server exactly as it was (no service stopped, no database dropped), a bad dump name must
// refuse before any database command, and the private scratch folder must be gone afterwards,
// pass or fail. A stub proves the order of the steps and the shape of the commands; only a run
// against a real restic repository and a real Postgres proves the restore itself.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync, rmSync, existsSync, symlinkSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BOX = join(here, "..");
const SCRIPT = join(BOX, "ops", "restore.sh");
const NEWEST_SQL = readdirSync(join(BOX, "sql")).filter((f) => /^[0-9].*\.sql$/.test(f)).sort().pop()!;

let dir: string, binDir: string, prefix: string, log: string, archive: string, scratchParent: string, ledgerFile: string;

function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(p, 0o755);
}
function write(rel: string, text: string, mode?: number) {
  const p = join(prefix, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  if (mode !== undefined) chmodSync(p, mode);
}
function writeArchive(rel: string, text: string, mode?: number) {
  const p = join(archive, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  if (mode !== undefined) chmodSync(p, mode);
}
function ledger(...names: string[]) {
  const rows = names.map((n, i) => `${n}\t${i + 1}\tchecksum\t2026-01-01 00:00:00+00\tapplied\t0\t${i + 1}`).join("\n");
  writeFileSync(
    ledgerFile,
    `--\n-- Data for Name: schema_migrations; Type: TABLE DATA\n--\n\nCOPY public.schema_migrations (filename, number, checksum, applied_at, how, took_ms, seq) FROM stdin;\n${rows}\n\\.\n\n`,
  );
}

/** System tools the script needs, linked into the stub directory so PATH holds nothing else. */
const SYSTEM_TOOLS = ["bash", "sh", "env", "cat", "sed", "grep", "awk", "tr", "head", "tail", "sort", "ls", "basename", "dirname",
  "mkdir", "cp", "rm", "mktemp", "chmod", "find", "wc", "cut", "date", "sleep", "python3"];
function linkSystemTools() {
  for (const t of SYSTEM_TOOLS) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (found) symlinkSync(found, join(binDir, t));
  }
}

function run(args: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  const r = spawnSync("/bin/bash", [SCRIPT, "--prefix", prefix, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    input: opts.input ?? "",
    env: {
      PATH: binDir, STUB_LOG: log, HOME: dir, ARCHIVE_ROOT: archive, LEDGER_FILE: ledgerFile,
      DRILL_SCRATCH_ROOT: scratchParent, DRILL_MIN_FREE_MB: "1", ...opts.env,
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
}
const base = () => ["--snapshot", "abc123", "--yes", "--old-server-stopped"];
const logLines = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
const idx = (re: RegExp, from = 0) => logLines().findIndex((l, i) => i >= from && re.test(l));
const lastIdx = (re: RegExp) => logLines().map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
const CHANGING = /(compose[^\n]* stop( |$)|dropdb|createdb|pg_restore[^\n]* -d |pnpm|--exit-on-error| up -d)/;
const changes = () => logLines().filter((l) => CHANGING.test(l));
const scratchLeft = () => readdirSync(scratchParent);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-restore-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix);
  archive = join(dir, "archive"); mkdirSync(archive);
  scratchParent = join(dir, "scratch"); mkdirSync(scratchParent);
  ledgerFile = join(dir, "ledger.txt");
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  linkSystemTools();

  // A finished fresh install: stack, keeper, secrets, the owner-copied files, no agents.
  write("opt/lares/compose.yaml", "services:\n  caddy:\n    environment:\n      LARES_DOMAIN: example.test\n");
  write("opt/lares/compose.lares-keeper.yaml", "services: {}\n");
  write("etc/lares/installation.env", "LARES_DOMAIN=example.test\n");
  write("etc/lares/keeper.env", "LARES_ROOT=/srv/lares\n");
  write("etc/lares/keeper.json", '{"project":"lares"}\n');
  write("etc/lares/backup.env", "RESTIC_REPOSITORY='/fake/repository'\nRESTIC_PASSWORD_FILE='/etc/lares/restic-password'\nLARES_CURRENT_LAYOUT='1'\n");
  write("etc/lares/restic-password", "not-a-real-password\n");
  write("etc/lares/secrets/database-password", "not-a-real-db-password\n");
  write("srv/lares/secrets/alpha-gateway-key", "not-a-real-key\n");
  write("srv/lares/secrets/alpha-telegram-token", "not-a-real-token\n");
  mkdirSync(join(prefix, "srv/lares/agents"), { recursive: true });
  mkdirSync(join(prefix, "srv/taste"), { recursive: true });

  // The snapshot.
  for (const db of ["lares_state", "postgres", "litellm", "empty_workflow"]) writeArchive(`var/backups/pg/${db}.dump`, `dump of ${db}\n`);
  writeArchive("var/backups/pg/globals.sql", "-- roles\n");
  writeArchive("var/backups/pg/secrets/agent-box-secrets.tar.age", "ciphertext\n");
  writeArchive("srv/lares/agents/alpha/agent.json", '{"name":"alpha"}\n', 0o640);
  writeArchive("srv/lares/retired/old/agent.json", "{}\n");
  writeArchive("srv/taste/note.md", "taste\n");
  writeArchive("srv/lares/installation/calendar.json", "{}\n");
  ledger("001_baseline.sql");

  stub("id", 'echo "${FAKE_UID:-0}"');
  stub("df", 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "stub 1 1 ${DF_AVAIL_KB:-99999999} 1% /"');
  stub("pnpm");
  stub("restic", `
if [ -n "\${RESTIC_FAIL:-}" ]; then echo "stub restic: boom" >&2; exit 1; fi
case " $* " in
  *" restore "*)
    target=""; prev=""
    for a in "$@"; do [ "$prev" = "--target" ] && target="$a"; prev="$a"; done
    cp -Rp "$ARCHIVE_ROOT/." "$target/"
    [ -z "\${SCRATCH_SEEN:-}" ] || ls "$target" > "$SCRATCH_SEEN"
    ;;
esac
exit 0`);
  stub("docker", `
case " $* " in
  *" pg_isready "*) cat >/dev/null 2>&1 </dev/null; exit "\${PG_ISREADY_RC:-0}" ;;
  *" psql "*) echo "\${FRESH_COUNTS:-0 0 0}"; exit 0 ;;
  *" pg_restore "*" -f - "*) cat >/dev/null; cat "$LEDGER_FILE"; exit 0 ;;
  *" pg_restore "*) cat >/dev/null; case " $* " in *" -d \${PG_RESTORE_FAIL_DB:-@none@} "*) exit 1 ;; esac; exit 0 ;;
  *" ps -q"*) echo "\${AGENTS_RUNNING:-}"; exit 0 ;;
esac
exit 0`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("restore.sh: a good restore", () => {
  it("does the steps in order: stop, drop and restore, migrate, copy folders, start the keeper last", () => {
    const r = run(base());
    expect(r.code, r.all).toBe(0);

    const stopKeeper = idx(/compose --env-file \S+keeper\.env -f \S+compose\.lares-keeper\.yaml stop/);
    const stopRest = idx(/compose -f \S+compose\.yaml stop console caddy lares-gateway/);
    const firstDrop = idx(/dropdb/);
    const lastRestore = lastIdx(/pg_restore .*--exit-on-error/);
    const migrate = idx(/^pnpm -C \S+ migrate$/);
    const baseUp = idx(/compose -f \S+compose\.yaml up -d$/);
    const keeperUp = idx(/compose\.lares-keeper\.yaml up -d$/);
    expect(stopKeeper).toBeGreaterThan(-1);
    expect(stopRest).toBeGreaterThan(stopKeeper);
    expect(firstDrop).toBeGreaterThan(stopRest);
    expect(migrate).toBeGreaterThan(lastRestore);
    expect(baseUp).toBeGreaterThan(migrate);
    expect(keeperUp).toBeGreaterThan(baseUp);
    expect(logLines().length - 1).toBe(keeperUp); // the keeper is the very last command
    expect(r.all).toContain("Start agent (applies saved definition)");
    expect(r.all).toContain("Apply connection changes (restarts agent)");
    expect(r.all).toContain("configure-google-keeper.py --org");
  });

  it("restores every dump except postgres into a dropped-and-recreated database, and postgres.dump into postgres", () => {
    expect(run(base()).code).toBe(0);
    for (const db of ["lares_state", "litellm", "empty_workflow"]) {
      const drop = idx(new RegExp(`dropdb -U lares --if-exists --force ${db}$`));
      const create = idx(new RegExp(`createdb -U lares ${db}$`));
      const restore = idx(new RegExp(`pg_restore --exit-on-error --no-owner --no-privileges -U lares -d ${db}$`));
      expect(drop, db).toBeGreaterThan(-1);
      expect(create, db).toBeGreaterThan(drop);
      expect(restore, db).toBeGreaterThan(create);
    }
    expect(idx(/pg_restore --exit-on-error --no-owner --no-privileges -U lares -d postgres$/)).toBeGreaterThan(-1);
    expect(logLines().filter((l) => /(dropdb|createdb)/.test(l) && /\bpostgres$/.test(l))).toEqual([]);
  });

  it("migrates with the database password in the environment, never on the command line", () => {
    expect(run(base()).code).toBe(0);
    expect(logLines().join("\n")).not.toContain("not-a-real-db-password");
  });

  it("copies the folders from the snapshot with their modes, and leaves nothing in the scratch root", () => {
    expect(run(base()).code).toBe(0);
    expect(readFileSync(join(prefix, "srv/lares/agents/alpha/agent.json"), "utf8")).toContain("alpha");
    expect(statSync(join(prefix, "srv/lares/agents/alpha/agent.json")).mode & 0o777).toBe(0o640);
    expect(existsSync(join(prefix, "srv/lares/retired/old/agent.json"))).toBe(true);
    expect(existsSync(join(prefix, "srv/taste/note.md"))).toBe(true);
    expect(existsSync(join(prefix, "srv/lares/installation/calendar.json"))).toBe(true);
    expect(scratchLeft()).toEqual([]);
  });

  it("restores into a private (0700) scratch folder", () => {
    const seen = join(dir, "seen.txt");
    // the stub lists the target while restoring; also check the mode of what mktemp made
    stub("restic", `
case " $* " in *" restore "*)
  target=""; prev=""; for a in "$@"; do [ "$prev" = "--target" ] && target="$a"; prev="$a"; done
  stat_out=$(ls -ld "$target" | cut -c1-10); echo "$stat_out" > "${seen}"
  cp -Rp "$ARCHIVE_ROOT/." "$target/" ;; esac
exit 0`);
    expect(run(base()).code).toBe(0);
    expect(readFileSync(seen, "utf8").trim()).toBe("drwx------");
  });

  it("asks for \"latest\" among nightly snapshots only", () => {
    expect(run(["--snapshot", "latest", "--yes", "--old-server-stopped"]).code).toBe(0);
    expect(logLines().find((l) => l.startsWith("restic") && l.includes(" restore "))).toMatch(/restore latest --tag nightly --target /);
  });

  it("does not print the gateway-key repair when every agent's key file came back", () => {
    const r = run(base());
    expect(r.all).toContain("Model gateway keys: nothing to do");
    expect(r.all).not.toContain("rotate-restored-gateway-key.py --agent");
  });

  it("tells the owner to re-register Telegram, and to re-run the installer for a restored deadline calendar", () => {
    writeArchive("srv/lares/installation/deadline-calendar.json", "{}\n");
    const r = run(base());
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain('press "Register Telegram webhook"');
    expect(r.all).toContain("Deadline calendar:");
    expect(r.all).toContain("install.sh --yes --release");
  });

  it("leaves the Telegram and calendar steps out when there is no Telegram token and no calendar", () => {
    rmSync(join(prefix, "srv/lares/secrets/alpha-telegram-token"));
    const r = run(base());
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("Register Telegram webhook");
    expect(r.all).not.toContain("Deadline calendar:");
  });

  it("prints the exact repair commands for an agent whose key file is missing", () => {
    rmSync(join(prefix, "srv/lares/secrets/alpha-gateway-key"));
    const r = run(base());
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("rotate-restored-gateway-key.py --agent alpha --execute");
  });

  it("asks twice when interactive, and goes ahead on 'stopped' and 'y'", () => {
    const r = run(["--snapshot", "abc123"], { input: "stopped\ny\n" });
    expect(r.code, r.all).toBe(0);
    expect(idx(/dropdb/)).toBeGreaterThan(-1);
  });
});

describe("restore.sh: every refusal changes nothing", () => {
  const refused = (r: ReturnType<typeof run>, why: RegExp) => {
    expect(r.code, r.all).toBe(78);
    expect(r.all).toMatch(why);
    expect(r.all).toMatch(/nothing (was|on this server was) changed/i);
    expect(changes()).toEqual([]);
    expect(scratchLeft()).toEqual([]);
  };

  it("not a current-layout install", () => {
    rmSync(join(prefix, "opt/lares/compose.yaml"));
    refused(run(base()), /not a finished Lares installation/);
  });
  it("no backup.env", () => {
    rmSync(join(prefix, "etc/lares/backup.env"));
    refused(run(base()), /backup\.env is missing/);
  });
  it("restic is not installed", () => {
    rmSync(join(binDir, "restic"));
    refused(run(base()), /restic/);
  });
  it("this server already has an agent definition", () => {
    refused(run(base(), { env: { FRESH_COUNTS: "1 0 0" } }), /already has 1 agent definition/);
  });
  it("this server already holds conversations", () => {
    refused(run(base(), { env: { FRESH_COUNTS: "0 2 5" } }), /already holds conversations/);
  });
  it("the agents folder is not empty", () => {
    write("srv/lares/agents/stray/agent.json", "{}");
    refused(run(base()), /agents is not empty/);
  });
  it("an agent container is running", () => {
    write("srv/lares/compose.lares-agents.yaml", "services: {}\n");
    refused(run(base(), { env: { AGENTS_RUNNING: "0123456789ab" } }), /agent container is running/);
  });
  it("the database does not answer", () => {
    refused(run(base(), { env: { PG_ISREADY_RC: "1" } }), /database container is not answering/);
  });
  it("--yes without --old-server-stopped", () => {
    refused(run(["--snapshot", "abc123", "--yes"]), /OLD server is switched off/);
  });
  it("the owner does not confirm the old server is stopped", () => {
    refused(run(["--snapshot", "abc123"], { input: "no\n" }), /not confirmed/);
  });
  it("the owner does not confirm the restore at the last question", () => {
    refused(run(["--snapshot", "abc123"], { input: "stopped\nn\n" }), /not confirmed/);
  });
  it("the snapshot has no lares_state.dump", () => {
    rmSync(join(archive, "var/backups/pg/lares_state.dump"));
    refused(run(base()), /no lares_state\.dump/);
  });
  it("a dump has an unsafe name, before any database command", () => {
    writeArchive("var/backups/pg/Evil-Name;x.dump", "x\n");
    const r = run(base());
    refused(r, /unsafe name/);
    expect(logLines().filter((l) => /(dropdb|createdb|pg_restore)/.test(l) && !/-f -/.test(l))).toEqual([]);
  });
  it("the snapshot's migration record is newer than this checkout", () => {
    ledger("001_baseline.sql", "99999_from_the_future.sql");
    refused(run(base()), /newer release/);
  });
  it("accepts a snapshot at exactly this checkout's newest migration", () => {
    ledger("001_baseline.sql", NEWEST_SQL);
    expect(run(base()).code).toBe(0);
  });
  it("the migration record cannot be read", () => {
    writeFileSync(ledgerFile, "nothing useful\n");
    refused(run(base()), /migration record/);
  });
  it("not enough free disk in the scratch root", () => {
    refused(run(base(), { env: { DF_AVAIL_KB: "1024", DRILL_MIN_FREE_MB: "5120" } }), /only 1MB is free/);
  });
  it("the restored domain differs from the one this server was installed with", () => {
    write("etc/lares/installation.env", "LARES_DOMAIN=other.example\n");
    refused(run(base()), /different address is not supported/);
  });
  it("the snapshot holds agents but the token folder is empty here", () => {
    rmSync(join(prefix, "srv/lares/secrets"), { recursive: true });
    mkdirSync(join(prefix, "srv/lares/secrets"));
    refused(run(base()), /token folder\) is empty/);
  });
  it("restic cannot restore the snapshot", () => {
    refused(run(base(), { env: { RESTIC_FAIL: "1" } }), /restic could not restore/);
  });
});

describe("restore.sh: arguments and failures", () => {
  it("needs --snapshot", () => {
    const r = run(["--yes"]);
    expect(r.code).toBe(64);
    expect(logLines()).toEqual([]);
  });
  it("refuses a snapshot id that is not letters and digits", () => {
    const r = run(["--snapshot", "x; rm -rf /", "--yes"]);
    expect(r.code).toBe(64);
    expect(logLines()).toEqual([]);
  });
  it("--help exits 64 and prints usage", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(64);
    expect(r.all).toContain("--snapshot");
  });
  it("refuses when not root", () => {
    const r = run(base(), { env: { FAKE_UID: "1000" } });
    expect(r.code).toBe(77);
    expect(changes()).toEqual([]);
    expect(logLines().filter((l) => !l.startsWith("id "))).toEqual([]);
  });

  it("--dry-run reads the snapshot but stops nothing, drops nothing and removes its scratch folder", () => {
    const r = run(["--snapshot", "abc123", "--dry-run"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("dry run");
    expect(changes()).toEqual([]);
    expect(scratchLeft()).toEqual([]);
    expect(existsSync(join(prefix, "srv/lares/agents/alpha"))).toBe(false);
  });

  it("a failed restore step stops there, says what changed, starts nothing, and still removes the scratch folder", () => {
    const r = run(base(), { env: { PG_RESTORE_FAIL_DB: "litellm" } });
    expect(r.code).toBe(75);
    expect(r.all).toContain("only part done");
    expect(r.all).toContain("database litellm dropped");
    expect(idx(/pnpm/)).toBe(-1);
    expect(idx(/ up -d$/)).toBe(-1);
    expect(existsSync(join(prefix, "srv/lares/agents/alpha"))).toBe(false);
    expect(scratchLeft()).toEqual([]);
  });

  it("a failed migration leaves the keeper stopped and the scratch folder removed", () => {
    stub("pnpm", "exit 3");
    const r = run(base());
    expect(r.code).toBe(75);
    expect(r.all).toContain("migration did not finish");
    expect(idx(/ up -d$/)).toBe(-1);
    expect(scratchLeft()).toEqual([]);
  });
});

// IMAGE MODE. On a box whose engine came from an image there is no pnpm: the migration runner
// runs in a throwaway container of that image, with the database password as a file.
describe("restore.sh: a box whose engine is an image", () => {
  const ENGINE = `registry.example/lares-keeper@sha256:${"d".repeat(64)}`;

  beforeEach(() => {
    rmSync(join(binDir, "pnpm"));
  });

  it("does not need pnpm, and migrates in the engine image after the last restore and before the stack starts", () => {
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE } });
    expect(r.code, r.all).toBe(0);
    const secrets = join(prefix, "etc", "lares", "secrets");
    const migrate = idx(/^docker run .*migrate\.ts$/);
    expect(migrate).toBeGreaterThan(lastIdx(/pg_restore .*--exit-on-error/));
    expect(migrate).toBeLessThan(idx(/compose -f \S+compose\.yaml up -d$/));
    const line = logLines()[migrate]!;
    expect(line).toContain(ENGINE);
    expect(line).toContain("--network host --user 0:0 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges");
    expect(line).toContain(`-e DATABASE_PASSWORD_FILE=${secrets}/database-password`);
    expect(line).toContain(`-v ${secrets}:${secrets}:ro`);
    expect(line).not.toContain("PGPASSWORD");
    expect(line).not.toContain("docker.sock");
    expect(logLines().join("\n")).not.toContain("not-a-real-db-password");
    expect(idx(/pnpm/)).toBe(-1);
  });

  it("refuses, changing nothing, when the named engine image is not a digest", () => {
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: "registry.example/lares-keeper:latest" } });
    expect(r.code).toBe(78);
    expect(r.all).toContain("engine image is not known");
    expect(changes()).toEqual([]);
  });

  it("refuses, changing nothing, when the engine image is absent and cannot be fetched", () => {
    stub("docker", `
case " $* " in
  *" image inspect "*|*" pull "*) exit 1 ;;
esac
exit 0`);
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE } });
    expect(r.code).toBe(78);
    expect(r.all).toContain("could not download the engine image");
    expect(changes()).toEqual([]);
  });

  it("a failed migration in the image leaves the keeper stopped", () => {
    stub("docker", `
case " $* " in
  *" pg_isready "*) exit 0 ;;
  *" psql "*) echo "0 0 0"; exit 0 ;;
  *" pg_restore "*" -f - "*) cat >/dev/null; cat "$LEDGER_FILE"; exit 0 ;;
  *" pg_restore "*) cat >/dev/null; exit 0 ;;
  *"/migrate.ts"*) exit 3 ;;
esac
exit 0`);
    const r = run(base(), { env: { LARES_ENGINE_IMAGE: ENGINE } });
    expect(r.code).toBe(75);
    expect(r.all).toContain("migration did not finish");
    expect(idx(/ up -d$/)).toBe(-1);
  });
});

it('refuses a missing prepared financial custody before stopping services or replacing any database',()=>{
  write('etc/lares/keeper.json',JSON.stringify({project:'lares',budgetFinancial:{directory:'/var/lib/lares/budget-financial'}}));
  const result=run(base());expect(result.code).toBe(78);expect(result.all).toContain('financial custody');expect(changes()).toEqual([]);
});
it('freezes prepared custody before the keeper stop while PostgreSQL stays running',()=>{
  write('etc/lares/keeper.json',JSON.stringify({project:'lares',budgetFinancial:{directory:'/var/lib/lares/budget-financial'}}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  const result=run(base());expect(result.code).toBe(0);
  expect(idx(/budget-financial.ts freeze --host/)).toBeGreaterThanOrEqual(0);
  expect(idx(/budget-financial.ts freeze --host/)).toBeLessThan(idx(/compose.* stop/));
  expect(logLines().some(line=>/compose.* stop.*\bdb\b/.test(line))).toBe(false);
});
it('does not freeze prepared custody on dry-run',()=>{
  write('etc/lares/keeper.json',JSON.stringify({project:'lares',budgetFinancial:{directory:'/var/lib/lares/budget-financial'}}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  const result=run([...base(),'--dry-run']);expect(result.code).toBe(0);expect(idx(/budget-financial.ts/)).toBe(-1);expect(changes()).toEqual([]);
});
it('refuses a failed live and fallback financial freeze before service stop or drop',()=>{
  write('etc/lares/keeper.json',JSON.stringify({project:'lares',budgetFinancial:{directory:'/var/lib/lares/budget-financial'}}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  stub('docker','case " $* " in *" budget-financial.ts "*|*" /app/services/keeper/bin/budget-financial.ts "*) exit 1 ;; *" psql "*) echo "0 0 0" ;; *" pg_restore "*" -f - "*) cat >/dev/null; cat "$LEDGER_FILE" ;; esac');
  stub('pnpm','exit 1');
  const result=run(base());expect(result.code).toBe(78);expect(result.all).toContain('not durably acknowledged');
  expect(logLines().filter(line=>/compose.* stop|dropdb|createdb|pg_restore.* -d /.test(line))).toEqual([]);
});
it('refuses an unbound existing financial directory instead of treating it as a legacy installation',()=>{
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  const result=run(base());expect(result.code).toBe(78);expect(result.all).toContain('financial custody');expect(changes()).toEqual([]);
});

it('reports prepared restored data as recovery-required without keeper or runtime readiness instructions',()=>{
  write('etc/lares/keeper.json',JSON.stringify({project:'lares',budgetFinancial:{directory:'/var/lib/lares/budget-financial'}}));
  mkdirSync(join(prefix,'var/lib/lares/budget-financial'),{recursive:true});
  const result=run(base());expect(result.code).toBe(0);expect(result.all).toContain('Financial recovery is required');expect(result.all).toContain('keeper startup refuses');
  expect(result.all).not.toContain('Sign in to the console');expect(result.all).not.toContain('Apply each agent');expect(result.all).not.toContain('keeper started');expect(result.all).toContain('Keep agents stopped');
});
