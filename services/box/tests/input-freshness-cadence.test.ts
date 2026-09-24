// LAR-17-s6 — the freshness alarm follows the configured cadence.
//
// input-freshness.sh section 5b pages when a schedule has stopped leaving its "completed a pass"
// trace. Each threshold in its table was agreed as "the schedule's period plus slack". Since
// LAR-17 the hours the digest and the CRM-routing passes run on are an owner setting
// (`schedule_settings`, sql/065), so for those two the threshold is now computed from the stored
// hours: the longest gap between consecutive slots (wrapping past midnight) + 4 h, never more than
// the 26 h a once-a-day schedule gets. An owner who switches to ONE digest a day must not be paged
// every evening by a number that assumed two.
//
// These tests run the real script under /bin/bash (3.2 on the Mac, the system bash on Linux) with a
// fake `docker` and a fake `curl` on PATH, in the stub style of backup-verify.test.ts. Nothing real
// is ever touched: no container, no database, no Kuma push.
//
// HOW THE EFFECTIVE THRESHOLD IS READ. An OK line does not print its threshold, a STALE line does
// ("threshold 20h"). So `thresholds()` stages an absurdly old heartbeat for the two schedules and
// parses the number out of their STALE lines; the verdict cases further down use realistic ages
// instead and assert on OK/STALE and the exit code, which is what the owner actually experiences.
//
// WHAT THE docker STUB BELIEVES about the settings read: ONE `psql -tAc` query against
// `schedule_settings` that returns a `_read_ok` marker line plus one `schedule=h,h,h` line per
// stored row (any owner). The marker is how the script tells "no rows" (marker only) from
// "could not read" (nothing at all) — `psql_one` swallows stderr, so an empty answer alone cannot
// say which. "the settings read is one query…" below pins the query text to that shape.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "input-freshness.sh");

/** The script's own table, parsed the way the two conformance tests parse it — so this file never
 *  repeats a key (or an agent name) and cannot drift from the table it is testing. */
function scriptTable(): { passes: Record<string, number>; ticks: string[] } {
  const src = readFileSync(SCRIPT, "utf8");
  const block = src.match(/SCHEDULE_PASSES="\n([\s\S]*?)\n"/)?.[1];
  if (!block) throw new Error("no SCHEDULE_PASSES block in input-freshness.sh");
  const passes: Record<string, number> = {};
  for (const line of block.split("\n").filter(Boolean)) {
    const m = line.match(/^([a-z-]+\/[a-z-]+):(\d+):.+$/);
    if (!m) throw new Error(`malformed SCHEDULE_PASSES line: ${line}`);
    passes[m[1]!] = Number(m[2]);
  }
  const ticks = src.match(/SCHEDULE_TICKS="([^"]+)"/)?.[1]?.trim().split(/\s+/) ?? [];
  return { passes, ticks };
}

const TABLE = scriptTable();
/** The table key for a bare settings name: `digest` -> `<agent>/digest`. */
function keyFor(schedule: string): string {
  const key = Object.keys(TABLE.passes).find((k) => k.endsWith(`/${schedule}`));
  if (!key) throw new Error(`no */${schedule} line in SCHEDULE_PASSES`);
  return key;
}
const DIGEST = keyFor("digest");
const CRM = keyFor("crm-routing");

let dir: string;
let binDir: string;
let heartbeatFile: string;
let settingsFile: string;
let queryLog: string;
let pushLog: string;

/** `orphans` are `key=age_hours` rows the heartbeat table holds but NO table line names. */
function stageHeartbeat(ages: Record<string, number> = {}, orphans: string[] = []): void {
  const lines: string[] = [];
  for (const key of Object.keys(TABLE.passes)) lines.push(`${key}=${ages[key] ?? 0}`);
  for (const key of TABLE.ticks) lines.push(`${key}/tick=0`);
  writeFileSync(heartbeatFile, [...lines, ...orphans].join("\n") + "\n");
}

/** `rows` are `schedule=h,h` lines exactly as the query returns them; the marker line is added
 *  here because a readable table always returns it, rows or no rows. */
function stageSettings(rows: string[]): void {
  writeFileSync(settingsFile, ["_read_ok", ...rows].join("\n") + "\n");
}

interface Run { status: number | null; stdout: string; stderr: string; lines: string[] }

function run(env: Record<string, string> = {}): Run {
  const r = spawnSync("/bin/bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
      HOME: dir,
      TMPDIR: dir,
      DB_CONTAINER: "stub-db",
      VAULT_PATH: join(dir, "vault"),
      NETWORK_DB: join(dir, "network.db"),
      NETWORK_DIR: "",
      KUMA_PUSH_URL: "",
      INPUT_FRESHNESS_ACK: "",
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines: r.stdout.split("\n").filter(Boolean) };
}

/** The threshold the script ACTUALLY applied to each of the two schedules, read off its STALE line. */
function thresholds(env: Record<string, string> = {}): { digest: number; crm: number; run: Run } {
  stageHeartbeat({ [DIGEST]: 9999, [CRM]: 9999 });
  const r = run(env);
  const read = (key: string): number => {
    const line = r.lines.find((l) => l.startsWith(`STALE ${key} `));
    const m = line?.match(/\(threshold (\d+)h;/);
    if (!m) throw new Error(`no "STALE ${key} … (threshold Nh; …" line in:\n${r.stdout}\n${r.stderr}`);
    return Number(m[1]);
  };
  return { digest: read(DIGEST), crm: read(CRM), run: r };
}

const warnings = (r: Run): string[] => r.lines.filter((l) => l.startsWith("WARN"));
/** Everything that decides the alarm: the per-check verdict lines and the closing summary. */
const verdict = (r: Run): string[] => r.lines.filter((l) => !l.startsWith("WARN"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "input-freshness-"));
  binDir = join(dir, "bin");
  mkdirSync(binDir);
  heartbeatFile = join(dir, "heartbeat.txt");
  settingsFile = join(dir, "settings.txt");
  queryLog = join(dir, "queries.log");
  pushLog = join(dir, "push.log");

  // Sections 1-3 read the filesystem: give them a fresh vault and a fresh replica so the only
  // thing that can turn a run red is the section under test.
  for (const sub of ["conversations", "dream"]) {
    mkdirSync(join(dir, "vault", "_meta", sub), { recursive: true });
    writeFileSync(join(dir, "vault", "_meta", sub, "today.md"), "x\n");
  }
  writeFileSync(join(dir, "network.db"), "");

  // Stub docker. `docker inspect` succeeds (the container "exists"); every other call is a
  // `docker exec … psql … -tAc "<query>"`, answered by the table the query names. Every query is
  // logged, one per line, so a test can count the settings reads.
  const docker = join(binDir, "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env bash\n` +
      `if [ "$1" = "inspect" ]; then exit 0; fi\n` +
      `query=""; for a in "$@"; do query="$a"; done\n` +
      `printf '%s\\n' "$query" >> "${queryLog}"\n` +
      `case "$query" in\n` +
      `  *"from schedule_settings"*)\n` +
      `    if [ -n "\${STUB_SETTINGS_FAIL:-}" ]; then echo 'ERROR:  relation "schedule_settings" does not exist' >&2; exit 1; fi\n` +
      `    cat "${settingsFile}" ;;\n` +
      `  *"from heartbeat"*) cat "${heartbeatFile}" ;;\n` +
      `  *"from reminders"*|*"from digest_requests"*) echo 0 ;;\n` +
      `  *) echo "stub docker: unexpected query: $query" >&2; exit 1 ;;\n` +
      `esac\n`,
  );
  chmodSync(docker, 0o755);

  // Stub curl: KUMA_PUSH_URL is empty so the script never calls it, but if it ever did, the push
  // must land in a log file and never on a real monitor.
  const curl = join(binDir, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash\necho "$@" >> "${pushLog}"\n`);
  chmodSync(curl, 0o755);

  stageHeartbeat();
  stageSettings([]);
});

afterEach(() => {
  expect(existsSync(pushLog), "the script must never push during these tests").toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

describe("input-freshness.sh: with no settings rows, nothing changes", () => {
  it("applies the table's own thresholds to the digest and to CRM routing", () => {
    const t = thresholds();
    expect(t.digest).toBe(TABLE.passes[DIGEST]);
    expect(t.crm).toBe(TABLE.passes[CRM]);
    expect(warnings(t.run)).toEqual([]);
  });

  it("an all-fresh box is green, with a verdict for every schedule in the table", () => {
    const r = run();
    expect(r.status).toBe(0);
    for (const key of Object.keys(TABLE.passes)) {
      expect(r.lines.some((l) => l.startsWith(`OK    ${key} `)), `OK line for ${key}`).toBe(true);
    }
    expect(warnings(r)).toEqual([]);
  });

  it("stored hours equal to the defaults give exactly the table's numbers (16 h overnight + 4)", () => {
    stageSettings(["digest=9,17", "crm-routing=9,13,17"]);
    const t = thresholds();
    expect(t.digest).toBe(TABLE.passes[DIGEST]);
    expect(t.crm).toBe(TABLE.passes[CRM]);
    expect(t.digest).toBe(20);
    expect(t.crm).toBe(20);
  });
});

describe("input-freshness.sh: the threshold follows the stored hours", () => {
  it("one digest a day -> 26 h, the number every once-a-day schedule in the table has", () => {
    stageSettings(["digest=9"]);
    const t = thresholds();
    expect(t.digest).toBe(26);
    expect(t.crm).toBe(TABLE.passes[CRM]); // untouched: no row of its own
    expect(warnings(t.run)).toEqual([]);
  });

  it("digest at 6, 12 and 18 -> the 12 h overnight gap + 4 = 16 h", () => {
    stageSettings(["digest=6,12,18"]);
    expect(thresholds().digest).toBe(16);
  });

  it("one CRM-routing pass a day -> 26 h, and the digest keeps its own number", () => {
    stageSettings(["crm-routing=9"]);
    const t = thresholds();
    expect(t.crm).toBe(26);
    expect(t.digest).toBe(TABLE.passes[DIGEST]);
  });

  it("two slots an hour apart are still a daily rhythm: 23 h + 4 is held at 26 h, never above", () => {
    stageSettings(["digest=9,10"]);
    expect(thresholds().digest).toBe(26);
  });

  it("hours stored out of order, or repeated, give the same answer as the sorted list", () => {
    stageSettings(["digest=17,9,9"]);
    expect(thresholds().digest).toBe(20);
  });

  it("two owners with different settings: the quieter one decides, so neither is paged falsely", () => {
    stageSettings(["digest=9,17", "digest=9"]);
    expect(thresholds().digest).toBe(26);
  });

  it("the owner-visible outcome: one digest a day, 21 h after the last pass, is NOT an alarm", () => {
    stageHeartbeat({ [DIGEST]: 21 });
    const before = run();
    expect(before.status).toBe(1); // the table's 20 h would page
    expect(before.lines.some((l) => l.startsWith(`STALE ${DIGEST} `))).toBe(true);

    stageSettings(["digest=9"]);
    const after = run();
    expect(after.status).toBe(0);
    expect(after.lines.some((l) => l.startsWith(`OK    ${DIGEST} `))).toBe(true);
  });

  it("…and a genuinely dead once-a-day digest still pages, at 26 h", () => {
    stageSettings(["digest=9"]);
    stageHeartbeat({ [DIGEST]: 26 });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.lines.some((l) => l.startsWith(`STALE ${DIGEST} `))).toBe(true);
  });

  it("the settings read is one query, for these two schedules only, carrying the marker", () => {
    run();
    const queries = readFileSync(queryLog, "utf8").split("\n").filter((q) => q.includes("schedule_settings"));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("'_read_ok'");
    expect(queries[0]).toMatch(/schedule in \('digest', ?'crm-routing'\)/);
  });
});

// An OPT-IN schedule (gate: `scheduleExplicitlyEnabled(`) has no table line — the script cannot yet
// tell "off on purpose" from "stopped" — but its migration still seeds its heartbeat rows, and on
// an installation that never opts in those rows only ever get older. This pins that such rows are
// INERT: section 5b's one heartbeat query does fetch them (they match its `like`), and then nothing
// looks them up, because every lookup is by a key taken from the table or the tick list. The keys
// are read out of the migration itself, so this file still never spells a key or an agent name.
describe("input-freshness.sh: a seeded heartbeat row that no table line names is inert", () => {
  const SEED = join(here, "..", "sql", "070_conversation_prune_heartbeat.sql");
  const seeded = [...readFileSync(SEED, "utf8").matchAll(/\('([a-z-]+\/[a-z-]+(?:\/tick)?)'\)/g)].map((m) => m[1]!);
  const orphans = seeded.map((key) => `${key}=9999`);

  it("the premise: sql/070 seeds a pass row and a tick row, and the table names neither", () => {
    expect(seeded).toHaveLength(2);
    expect(seeded[1]).toBe(`${seeded[0]}/tick`);
    // If this fails because the line came back (the script learned to SKIP a schedule that is off
    // on purpose), this whole describe has done its job and should be replaced by that feature's tests.
    expect(Object.keys(TABLE.passes)).not.toContain(seeded[0]);
    expect(TABLE.ticks).not.toContain(seeded[0]);
  });

  it("the script's heartbeat query DOES fetch those rows — they are read, then ignored", () => {
    run();
    const queries = readFileSync(queryLog, "utf8").split("\n").filter((q) => q.includes("from heartbeat"));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(`agent like '${seeded[0]!.split("/")[0]}/%'`);
  });

  it("all-fresh box, both rows 9999 h old: same exit code, same output, byte for byte", () => {
    const baseline = run();
    stageHeartbeat({}, orphans);
    const r = run();
    expect(baseline.status).toBe(0);
    expect(r.status).toBe(baseline.status);
    expect(r.stdout).toBe(baseline.stdout);
    expect(r.stderr).toBe(baseline.stderr);
    for (const key of seeded) expect(r.stdout).not.toContain(key);
  });

  it("a box that is already red for another reason: still the same verdict, nothing added", () => {
    stageHeartbeat({ [DIGEST]: 9999 });
    const baseline = run();
    stageHeartbeat({ [DIGEST]: 9999 }, orphans);
    const r = run();
    expect(baseline.status).toBe(1);
    expect(r.status).toBe(baseline.status);
    expect(r.stdout).toBe(baseline.stdout);
    expect(r.stderr).toBe(baseline.stderr);
  });

  it("rows listed FIRST in the query's answer change nothing either", () => {
    const baseline = run();
    const staged = readFileSync(heartbeatFile, "utf8");
    writeFileSync(heartbeatFile, orphans.join("\n") + "\n" + staged);
    const r = run();
    expect(r.status).toBe(baseline.status);
    expect(r.stdout).toBe(baseline.stdout);
  });
});

describe("input-freshness.sh: settings it cannot use fall back to the table, out loud", () => {
  it("an unreadable settings table: the table's numbers, exactly one warning line", () => {
    const baseline = thresholds();
    const t = thresholds({ STUB_SETTINGS_FAIL: "1" });
    expect(t.digest).toBe(TABLE.passes[DIGEST]);
    expect(t.crm).toBe(TABLE.passes[CRM]);
    expect(warnings(t.run)).toHaveLength(1);
    expect(warnings(t.run)[0]).toContain("schedule_settings");
    expect(t.run.status).toBe(baseline.run.status);
    expect(verdict(t.run)).toEqual(verdict(baseline.run));
  });

  it("an unreadable settings table on an all-fresh box: still green, same verdict, one warning", () => {
    const baseline = run();
    const r = run({ STUB_SETTINGS_FAIL: "1" });
    expect(baseline.status).toBe(0);
    expect(r.status).toBe(0);
    expect(verdict(r)).toEqual(verdict(baseline));
    expect(warnings(r)).toHaveLength(1);
  });

  it("an empty answer (no marker at all) is unreadable, not 'no rows'", () => {
    writeFileSync(settingsFile, "");
    const t = thresholds();
    expect(t.digest).toBe(TABLE.passes[DIGEST]);
    expect(warnings(t.run)).toHaveLength(1);
  });

  for (const bad of ["digest=", "digest={}", "digest=nine", "digest=9,,17", "digest=25", "digest=09", "digest=-1,9"]) {
    it(`a malformed stored value (${JSON.stringify(bad)}) keeps the table's number, with one warning`, () => {
      const baseline = thresholds();
      stageSettings([bad, "crm-routing=9"]);
      const t = thresholds();
      expect(t.digest).toBe(TABLE.passes[DIGEST]);
      expect(t.crm).toBe(26); // the readable row beside it is still honoured
      expect(warnings(t.run)).toHaveLength(1);
      expect(warnings(t.run)[0]).toContain("digest");
      expect(t.run.status).toBe(baseline.run.status);
      expect(t.run.stderr).not.toMatch(/unbound variable|syntax error|value too great|integer expression/);
    });
  }

  it("both stored values malformed: both keep the table's numbers, still ONE warning line", () => {
    stageSettings(["digest=nine", "crm-routing={}"]);
    const t = thresholds();
    expect(t.digest).toBe(TABLE.passes[DIGEST]);
    expect(t.crm).toBe(TABLE.passes[CRM]);
    expect(warnings(t.run)).toHaveLength(1);
  });

  it("one owner's value malformed beside another owner's good one: the table's number, not a guess", () => {
    stageSettings(["digest=9", "digest=nine"]);
    const t = thresholds();
    expect(t.digest).toBe(TABLE.passes[DIGEST]);
    expect(warnings(t.run)).toHaveLength(1);
  });
});
