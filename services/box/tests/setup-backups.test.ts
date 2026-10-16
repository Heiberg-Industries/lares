// setup-backups.sh is the one command that switches the backup jobs on and proves them once
// (docs/install.md section 9). These tests drive it with logging stubs on PATH (restic, age,
// curl, systemctl, id, stat) and a temporary prefix, the same pattern as
// tests/install-restore.test.ts. Nothing here touches a real repository, systemd or the network.
//
// The restic 0.16 "repository is missing" text is copied from restic's source
// (cmd/restic/global.go at v0.16.4); only a run against a real 0.16 repository proves it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync, rmSync, existsSync, statSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OPS = join(here, "..", "ops");
const SCRIPT = join(OPS, "setup-backups.sh");

const GOOD_KEY = "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsz0abcde";
const GOOD_HC = "https://hc.example.net/ping/0b3c1f5e-1111-2222-3333-444455556666";

let dir: string, binDir: string, prefix: string, log: string, repoDir: string, pwFile: string, state: string;

function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(args: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  const r = spawnSync("/bin/bash", [SCRIPT, "--prefix", prefix, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    input: opts.input ?? "",
    env: {
      PATH: `${binDir}:/usr/bin:/bin`, STUB_LOG: log, HOME: dir, STATE: state,
      PREFIX_FOR_STAT: prefix, RESTIC_MODE: "absent10", ...opts.env,
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
}

/** Every file under the prefix, with its size, so "nothing was written" is checkable. */
function tree(root = prefix, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = join(rel, e.name);
    if (e.isDirectory()) out.push(p + "/", ...tree(root, p));
    else out.push(`${p}:${statSync(join(root, p)).size}`);
  }
  return out.sort();
}

const base = () => ["--yes", "--repository", "sftp:backup@host.example.net:/restic", "--age-recipient", GOOD_KEY, "--hc-url", GOOD_HC, "--password-file", pwFile];
const logLines = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
const inits = () => logLines().filter((l) => / init$/.test(l));
const withOverride = (key: string, value: string) => {
  const a = base();
  a[a.indexOf(key) + 1] = value;
  return a;
};
const withoutPasswordFile = () => {
  const a = base();
  a.splice(a.indexOf("--password-file"), 2);
  return a;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-setup-backups-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root");
  mkdirSync(join(prefix, "opt", "lares"), { recursive: true });
  mkdirSync(join(prefix, "etc", "lares"), { recursive: true });
  writeFileSync(join(prefix, "opt", "lares", "compose.yaml"), "services: {}\n");
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  state = join(dir, "repo-initialised");
  repoDir = join(dir, "second-disk"); mkdirSync(repoDir);
  pwFile = "/etc/lares/given-password"; // logical path; the file lives under the prefix
  writeFileSync(join(prefix, pwFile), "correct horse battery staple\n"); chmodSync(join(prefix, pwFile), 0o400);

  stub("id", "echo 0");
  for (const n of ["age", "curl"]) stub(n);
  stub("systemctl", `if [ "$1" = start ] && case " \${FAIL_UNITS:-} " in *" $2 "*) true ;; *) false ;; esac; then exit 1; fi; exit 0`);
  // stat -c %d <path>: the prefix is device 1, everything else device 2, unless STAT_SAME is set.
  // stat -c %a <path>: the real mode, read with python (macOS stat has no -c).
  stub("stat", `
if [ "$2" = "%u" ]; then
  if [ -n "\${STAT_NOTROOT_MATCH:-}" ] && case "$3" in *"$STAT_NOTROOT_MATCH"*) true ;; *) false ;; esac; then echo 1000; else echo 0; fi
elif [ "$2" = "%d" ]; then
  if [ -n "\${STAT_SAME:-}" ] || [ "$3" = "$PREFIX_FOR_STAT" ]; then echo 1; else echo 2; fi
else
  python3 -c "import os,sys;print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])" "$3"
fi`);
  stub("restic", `
case " $* " in *" init "*) touch "$STATE"; exit 0 ;; esac
if [ -f "$STATE" ]; then exit 0; fi
case "$RESTIC_MODE" in
  open) exit 0 ;;
  absent10) exit 10 ;;
  absent16) printf 'Fatal: unable to open config file: stat /x/config: no such file or directory\\nIs there a repository at the following location?\\n/x\\n' >&2; exit 1 ;;
  denied) printf 'Fatal: unable to open config file: Stat: Access Denied.\\nIs there a repository at the following location?\\ns3:x\\n' >&2; exit 1 ;;
  wrongpw) echo 'Fatal: wrong password or no key found' >&2; exit 1 ;;
  *) echo 'something unexpected' >&2; exit 1 ;;
esac`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("refusals leave nothing written", () => {
  const refuse = (args: string[], env: Record<string, string> = {}, expectText?: RegExp) => {
    const before = tree();
    const r = run(args, { env });
    expect(r.code).toBe(78);
    expect(tree()).toEqual(before);
    expect(inits()).toEqual([]);
    if (expectText) expect(r.all).toMatch(expectText);
    return r;
  };

  it("no current-layout install", () => {
    rmSync(join(prefix, "opt", "lares", "compose.yaml"));
    refuse(base(), {}, /not a finished Lares installation/);
  });
  it("a missing tool prints the apt-get line", () => {
    // A machine may really have age in /usr/bin: give the script a PATH that never does.
    const sys = join(dir, "sysbin"); mkdirSync(sys);
    for (const d of ["/usr/bin", "/bin"]) {
      for (const f of readdirSync(d)) {
        if (["age", "age-keygen"].includes(f) || existsSync(join(sys, f))) continue;
        try { symlinkSync(join(d, f), join(sys, f)); } catch { /* already there */ }
      }
    }
    rmSync(join(binDir, "age"));
    refuse(base(), { PATH: `${binDir}:${sys}` }, /apt-get install -y age/);
  });
  it("HC url empty, not https, or the placeholder", () => {
    const before = tree();
    expect(run(withOverride("--hc-url", "")).code).toBe(64);
    expect(tree()).toEqual(before);
    refuse(withOverride("--hc-url", "http://hc.example.net/ping/abc"), {}, /https/);
    refuse(withOverride("--hc-url", "https://hc-ping.com/REPLACE-WITH-UUID"), {}, /placeholder/);
  });
  it("an age recipient that is not a public key", () => {
    refuse(withOverride("--age-recipient", "not-a-key"), {}, /not a public age key/);
  });
  it("an age PRIVATE key is refused loudly and never echoed", () => {
    const secret = "AGE-SECRET-KEY-1ABCDEFGHJKLMNPQRSTUVWXYZ";
    const r = refuse(withOverride("--age-recipient", secret), {}, /PRIVATE key[\s\S]*off the server/);
    expect(r.all).not.toContain(secret);
  });
  it("a local path on the same disk as the server", () => {
    const r = refuse(withOverride("--repository", repoDir), { STAT_SAME: "1" }, /same disk/);
    expect(r.all).toMatch(/not a backup/);
  });
  it("credentials embedded in the repository string", () => {
    refuse(withOverride("--repository", "s3:https://AKIAXXX:topsecret@s3.example.net/bucket"), {}, /password or key/);
    refuse(withOverride("--repository", "s3:https://s3.example.net/bucket?secret=abc"), {}, /password or key/);
    refuse(withOverride("--repository", "sftp:user:hunter2@host.example.net:/r"), {}, /password or key/);
  });
  it("an existing backup.env that differs, naming keys but not values", () => {
    writeFileSync(join(prefix, "etc", "lares", "backup.env"), "HC_URL='https://hc.example.net/ping/OTHER-SECRET-VALUE'\nLARES_CURRENT_LAYOUT='1'\n", { mode: 0o400 });
    const r = refuse(base(), {}, /differs.*HC_URL/);
    expect(r.all).not.toContain("OTHER-SECRET-VALUE");
  });
  it("a repository that exists but will not open with this password", () => {
    refuse(base(), { RESTIC_MODE: "wrongpw" }, /does not open it/);
  });
  it("an ambiguous restic failure never initialises", () => {
    refuse(base(), { RESTIC_MODE: "other" }, /could not tell/);
    refuse(base(), { RESTIC_MODE: "denied" }, /could not tell/);
  });
  it("a generated password with --yes needs --password-saved", () => {
    refuse(withoutPasswordFile(), {}, /--password-saved/);
  });
  it("an S3 credentials file readable by others", () => {
    const creds = join(dir, "s3creds");
    writeFileSync(creds, "AWS_ACCESS_KEY_ID=AKIAEXAMPLE\nAWS_SECRET_ACCESS_KEY=sekret\n");
    chmodSync(creds, 0o644);
    const a = [...withOverride("--repository", "s3:https://s3.example.net/bucket"), "--s3-credentials-file", creds];
    const r = refuse(a, {}, /readable by others/);
    expect(r.all).not.toContain("sekret");
  });
});

describe("review fixes", () => {
  const envPath = () => join(prefix, "etc/lares/backup.env");
  const handEditedLines = () => [
    "# my own note about this server",
    `HC_URL='${GOOD_HC}'`,
    "LARES_CURRENT_LAYOUT=1",
    "RESTIC_REPOSITORY=sftp:backup@host.example.net:/restic",
    `RESTIC_PASSWORD_FILE=${pwFile}`,
    `AGE_SECRETS_RECIPIENT=${GOOD_KEY}`,
    "export LARES_WORKFLOW_VOLUMES=\"a_workflow_files\"",
    "",
  ].join("\n");
  const handEditedText = () => handEditedLines();

  it("keeps export lines and comments with --reconfigure, and a plain re-run then changes nothing", () => {
    writeFileSync(envPath(), handEditedText(), { mode: 0o400 });
    expect(run(base(), { env: { RESTIC_MODE: "open" } }).code).toBe(78); // plain run refuses a hand-edited file
    expect(readFileSync(envPath(), "utf8")).toBe(handEditedText());
    expect(run([...base(), "--reconfigure"], { env: { RESTIC_MODE: "open" } }).code).toBe(0);
    const env = readFileSync(envPath(), "utf8");
    expect(env).toContain('export LARES_WORKFLOW_VOLUMES="a_workflow_files"');
    expect(env).toContain("# my own note about this server");
    const again = run(base(), { env: { RESTIC_MODE: "open" } });
    expect(again.code).toBe(0);
    expect(readFileSync(envPath(), "utf8")).toBe(env);
  });

  it("a plain re-run on a hand-edited file refuses and says why, with no changes", () => {
    writeFileSync(envPath(), handEditedText(), { mode: 0o400 });
    const before = tree();
    const r = run(base(), { env: { RESTIC_MODE: "open" } });
    expect(r.code).toBe(78);
    expect(r.all).toMatch(/edited by hand/);
    expect(tree()).toEqual(before);
  });

  it("--reconfigure refuses when a value is spread over several lines", () => {
    writeFileSync(envPath(), `${handEditedText()}NOTE="first\nsecond"\n`, { mode: 0o400 });
    const before = tree();
    const r = run([...base(), "--reconfigure"], { env: { RESTIC_MODE: "open" } });
    expect(r.code).toBe(78);
    expect(r.all).toMatch(/cannot be carried over/);
    expect(tree()).toEqual(before);
  });

  it("--accept-same-machine works but never says Protected; it says NOT off-site", () => {
    const r = run([...withOverride("--repository", repoDir), "--accept-same-machine"], { env: { STAT_SAME: "1" } });
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("Protected");
    expect(r.all).toMatch(/NOT off-site/);
  });

  it("a missing S3 bucket refuses and never initialises; a missing key is absent", () => {
    const stubS3 = (msg: string) => stub("restic", `case " $* " in *" init "*) touch "$STATE"; exit 0 ;; esac\nprintf '%s\\n' '${msg}' >&2; exit 1`);
    const creds = join(dir, "s3creds");
    writeFileSync(creds, "AWS_ACCESS_KEY_ID=AKIAEXAMPLE\nAWS_SECRET_ACCESS_KEY=sekret\n");
    chmodSync(creds, 0o600);
    const a = [...withOverride("--repository", "s3:https://s3.example.net/bucket"), "--s3-credentials-file", creds];
    stubS3("Fatal: unable to open config file: Stat: The specified bucket does not exist. Is there a repository at the following location? s3:x");
    const before = tree();
    const r = run(a);
    expect(r.code).toBe(78);
    expect(r.all).toMatch(/create the bucket first/);
    expect(inits()).toEqual([]);
    expect(tree()).toEqual(before);
    stubS3("Fatal: unable to open config file: Stat: The specified key does not exist. Is there a repository at the following location? s3:x");
    expect(run(a).code).toBe(0);
    expect(inits()).toHaveLength(1);
  });

  it("an existing password file or S3 credentials file not owned by root is refused, and never read", () => {
    const r = run(base(), { env: { STAT_NOTROOT_MATCH: "given-password" } });
    expect(r.code).toBe(78);
    expect(r.all).toMatch(/not owned by root[\s\S]*chown root:root/);
    const creds = join(dir, "s3creds");
    writeFileSync(creds, "touch " + join(dir, "SOURCED") + "\nAWS_ACCESS_KEY_ID=A\nAWS_SECRET_ACCESS_KEY=B\n");
    chmodSync(creds, 0o600);
    const a = [...withOverride("--repository", "s3:https://s3.example.net/bucket"), "--s3-credentials-file", creds];
    const r2 = run(a, { env: { STAT_NOTROOT_MATCH: "s3creds" } });
    expect(r2.code).toBe(78);
    expect(existsSync(join(dir, "SOURCED"))).toBe(false);
  });

  it("a password file readable by the group is refused", () => {
    chmodSync(join(prefix, pwFile), 0o440);
    const r = run(base());
    expect(r.code).toBe(78);
    expect(r.all).toMatch(/readable by others/);
  });

  it("an older backup setup is refused without --reconfigure", () => {
    mkdirSync(join(prefix, "etc/agent-box"), { recursive: true });
    writeFileSync(join(prefix, "etc/agent-box/backup.env"), "HC_URL=x\n");
    const before = tree();
    const r = run(base());
    expect(r.code).toBe(78);
    expect(r.all).toMatch(/older backup setup/);
    expect(tree()).toEqual(before);
    expect(run([...base(), "--reconfigure"]).code).toBe(0);
  });

  it("an existing unit that is replaced is kept as <name>.previous", () => {
    mkdirSync(join(prefix, "etc/systemd/system"), { recursive: true });
    const unit = join(prefix, "etc/systemd/system/lares-backup.timer");
    writeFileSync(unit, "[Timer]\nOnCalendar=hourly\n");
    expect(run(base()).code).toBe(0);
    expect(readFileSync(`${unit}.previous`, "utf8")).toContain("hourly");
    expect(readFileSync(unit, "utf8")).toContain("03:00:00");
  });

  it("a failed restic init is 'partly done' (75), lists what was written, and a re-run is safe", () => {
    stub("restic", `case " $* " in *" init "*) echo 'init exploded' >&2; exit 1 ;; esac\nexit 10`);
    const r = run(withoutPasswordFile().concat("--password-saved"));
    expect(r.code).toBe(75);
    expect(r.stderr).toMatch(/partly done[\s\S]*backup\.env/);
    expect(r.stderr).toMatch(/safe to repeat/);
    expect(r.stdout).toContain("cat /etc/lares/restic-password");
    const secret = readFileSync(join(prefix, "etc/lares/restic-password"), "utf8").trim();
    expect(r.all).not.toContain(secret);
  });
});

describe("a good run", () => {
  it("creates an absent repository (exit 10), with the right file modes and the order backup, drill, verify", () => {
    const r = run(base());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Protected");
    expect(inits()).toHaveLength(1);
    const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
    expect(mode(join(prefix, "etc/lares/backup.env"))).toBe("400");
    for (const s of ["backup.sh", "backup-verify.sh", "restore-drill.sh"]) expect(mode(join(prefix, "opt/lares", s))).toBe("750");
    expect(existsSync(join(prefix, "etc/systemd/system/lares-restore-drill.timer"))).toBe(true);
    const env = readFileSync(join(prefix, "etc/lares/backup.env"), "utf8");
    expect(env).toContain("LARES_CURRENT_LAYOUT='1'");
    expect(env).toContain("RESTIC_REPOSITORY='sftp:backup@host.example.net:/restic'");
    expect(env).toContain(`AGE_SECRETS_RECIPIENT='${GOOD_KEY}'`);
    expect(logLines().filter((l) => l.startsWith("systemctl"))).toEqual([
      "systemctl daemon-reload",
      "systemctl enable --now lares-backup.timer lares-backup-verify.timer lares-restore-drill.timer",
      "systemctl start lares-backup.service",
      "systemctl start lares-restore-drill.service",
      "systemctl start lares-backup-verify.service",
    ]);
    expect(readdirSync(join(prefix, "etc/lares")).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });

  it("creates the repository when restic 0.16 prints its missing-repository text", () => {
    expect(run(base(), { env: { RESTIC_MODE: "absent16" } }).code).toBe(0);
    expect(inits()).toHaveLength(1);
  });

  it("reuses a repository that already opens, without init", () => {
    expect(run(base(), { env: { RESTIC_MODE: "open" } }).code).toBe(0);
    expect(inits()).toEqual([]);
  });

  it("a second run with the same inputs changes nothing and does not re-init", () => {
    expect(run(base()).code).toBe(0);
    const files = ["etc/lares/backup.env", "opt/lares/backup.sh", "etc/systemd/system/lares-backup.service"].map((f) => join(prefix, f));
    const before = files.map((f) => statSync(f).mtimeMs);
    const treeBefore = tree();
    writeFileSync(log, "");
    const r = run(base());
    expect(r.code).toBe(0);
    expect(files.map((f) => statSync(f).mtimeMs)).toEqual(before);
    expect(tree()).toEqual(treeBefore);
    expect(r.stdout).not.toMatch(/wrote /);
    expect(inits()).toEqual([]);
  });

  it("--reconfigure replaces a differing env, keeps unmanaged settings and the old file", () => {
    writeFileSync(join(prefix, "etc/lares/backup.env"), "HC_URL='https://hc.example.net/ping/old'\nLARES_WORKFLOW_VOLUMES=\"a_workflow_files\"\n", { mode: 0o400 });
    const r = run([...base(), "--reconfigure"], { env: { RESTIC_MODE: "open" } });
    expect(r.code).toBe(0);
    const env = readFileSync(join(prefix, "etc/lares/backup.env"), "utf8");
    expect(env).toContain(`HC_URL='${GOOD_HC}'`);
    expect(env).toContain('LARES_WORKFLOW_VOLUMES="a_workflow_files"');
    expect(existsSync(join(prefix, "etc/lares/backup.env.previous"))).toBe(true);
  });

  it("a re-run with only --yes reuses the saved answers", () => {
    expect(run(base()).code).toBe(0);
    expect(run(["--yes"]).code).toBe(0);
  });

  it("generates a password file (0400) only with --password-saved, and never prints it", () => {
    const r = run([...withoutPasswordFile(), "--password-saved"]);
    expect(r.code).toBe(0);
    const pw = join(prefix, "etc/lares/restic-password");
    expect((statSync(pw).mode & 0o777).toString(8)).toBe("400");
    const secret = readFileSync(pw, "utf8").trim();
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(r.all).not.toContain(secret);
    expect(readFileSync(join(prefix, "etc/lares/backup.env"), "utf8")).toContain("RESTIC_PASSWORD_FILE='/etc/lares/restic-password'");
  });

  it("interactive: asks, shows the generated password once, and needs the word saved", () => {
    const answers = ["sftp:backup@host.example.net:/restic", GOOD_KEY, GOOD_HC];
    const r = run([], { input: [...answers, "saved", "y", ""].join("\n") });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/password: \S{32,}/);
    expect(existsSync(join(prefix, "etc/lares/restic-password"))).toBe(true);
  });

  it("interactive: without the word saved, nothing is written", () => {
    rmSync(state, { force: true });
    const before = tree();
    const r = run([], { input: ["sftp:backup@host.example.net:/other", GOOD_KEY, GOOD_HC, "nope", ""].join("\n") });
    expect(r.code).toBe(78);
    expect(tree()).toEqual(before);
  });

  it("S3 keys come from the credentials file, land in the 0400 env, and never in argv or output", () => {
    const creds = join(dir, "s3creds");
    writeFileSync(creds, "AWS_ACCESS_KEY_ID=AKIAEXAMPLE\nAWS_SECRET_ACCESS_KEY=sekret-value\n");
    chmodSync(creds, 0o600);
    const a = withOverride("--repository", "s3:https://s3.example.net/bucket");
    const r = run([...a, "--s3-credentials-file", creds]);
    expect(r.code).toBe(0);
    const env = readFileSync(join(prefix, "etc/lares/backup.env"), "utf8");
    expect(env).toContain("AWS_ACCESS_KEY_ID='AKIAEXAMPLE'");
    expect(env).toContain("AWS_SECRET_ACCESS_KEY='sekret-value'");
    expect(readFileSync(log, "utf8")).not.toContain("sekret-value");
    expect(r.all).not.toContain("sekret-value");
  });

  it("--dry-run writes nothing and starts nothing", () => {
    const before = tree();
    const r = run([...base(), "--dry-run"]);
    expect(r.code).toBe(0);
    expect(tree()).toEqual(before);
    expect(logLines().filter((l) => /^systemctl|init$/.test(l))).toEqual([]);
  });

  it("--skip-first-run enables the timers but starts no job and does not say Protected", () => {
    const r = run([...base(), "--skip-first-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Protected");
    expect(logLines().some((l) => l.startsWith("systemctl start"))).toBe(false);
  });

  it("a local path on a second disk is accepted", () => {
    expect(run(withOverride("--repository", join(repoDir, "restic-repo"))).code).toBe(0);
  });
});

describe("first run", () => {
  it("a failing drill is named, 'Protected' is not said, and the log is pointed at", () => {
    const r = run(base(), { env: { FAIL_UNITS: "lares-restore-drill.service" } });
    expect(r.code).toBe(75);
    expect(r.all).not.toContain("Protected");
    expect(r.all).toContain("journalctl -u lares-restore-drill.service");
    expect(r.stderr).toMatch(/NOT protected yet. Failed: lares-restore-drill.service/);
  });
  it("a failing backup stops the rest", () => {
    const r = run(base(), { env: { FAIL_UNITS: "lares-backup.service" } });
    expect(r.code).toBe(75);
    expect(logLines().filter((l) => l.startsWith("systemctl start"))).toEqual(["systemctl start lares-backup.service"]);
  });
});

describe("units that point at the wrong place are corrected", () => {
  it("rewrites ExecStart and the settings path from a checkout whose unit is wrong", () => {
    const copy = join(dir, "ops-copy");
    execFileSync("cp", ["-R", OPS, copy]);
    const unit = join(copy, "lares-backup.service");
    writeFileSync(unit, readFileSync(unit, "utf8").replace("/opt/lares/backup.sh", "/opt/agent-box/backup.sh").replace("/etc/lares/backup.env", "/etc/agent-box/backup.env"));
    const r = spawnSync("/bin/bash", [join(copy, "setup-backups.sh"), "--prefix", prefix, ...base(), "--skip-first-run"], {
      encoding: "utf8", timeout: 20_000,
      env: { PATH: `${binDir}:/usr/bin:/bin`, STUB_LOG: log, HOME: dir, STATE: state, PREFIX_FOR_STAT: prefix, RESTIC_MODE: "open" },
    });
    expect(r.status).toBe(0);
    const installed = readFileSync(join(prefix, "etc/systemd/system/lares-backup.service"), "utf8");
    expect(installed).toContain("ExecStart=/opt/lares/backup.sh");
    expect(installed).toContain("Environment=AGENT_BOX_BACKUP_ENV=/etc/lares/backup.env");
    expect(installed).not.toContain("agent-box");
  });
});

describe("install.sh --backups", () => {
  it("hands over to setup-backups.sh with the other arguments", () => {
    const r = spawnSync("/bin/bash", [join(OPS, "install.sh"), "--backups", "--prefix", prefix, ...base(), "--dry-run"], {
      encoding: "utf8", timeout: 20_000,
      env: { PATH: `${binDir}:/usr/bin:/bin`, STUB_LOG: log, HOME: dir, STATE: state, PREFIX_FOR_STAT: prefix, RESTIC_MODE: "absent10" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dry run");
  });
});

describe("the backup scripts find /etc/lares/backup.env on their own", () => {
  it.each(["backup.sh", "backup-verify.sh", "restore-drill.sh", "export.sh"])("%s defaults to /etc/lares/backup.env when it exists", (name) => {
    const text = readFileSync(join(OPS, name), "utf8");
    expect(text).toContain("[ -f /etc/lares/backup.env ] && DEFAULT_BACKUP_ENV=/etc/lares/backup.env");
    expect(text).toContain("DEFAULT_BACKUP_ENV=/etc/agent-box/backup.env");
    expect(text).not.toMatch(/:-\/etc\/agent-box\/backup\.env/);
  });
  it("the units still pass the path explicitly", () => {
    for (const u of ["lares-backup.service", "lares-backup-verify.service", "lares-restore-drill.service"]) {
      const text = readFileSync(join(OPS, u), "utf8");
      expect(text).toContain("Environment=AGENT_BOX_BACKUP_ENV=/etc/lares/backup.env");
      expect(text).toMatch(/ExecStart=\/opt\/lares\//);
    }
  });
  it("an explicit AGENT_BOX_BACKUP_ENV still wins (old servers keep working)", () => {
    const envFile = join(dir, "old.env");
    writeFileSync(envFile, "echo SOURCED-OLD-ENV >&2; exit 3\n");
    const r = spawnSync("/bin/bash", [join(OPS, "backup.sh")], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", AGENT_BOX_BACKUP_ENV: envFile } });
    expect(r.stderr).toContain("SOURCED-OLD-ENV");
  });
});
