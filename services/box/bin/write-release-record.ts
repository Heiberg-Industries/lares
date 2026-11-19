// services/box/bin/write-release-record.ts — writes the release file and the notes of a test release
// from what a publishing run produced (lib/release-record.ts, lib/release-plan.ts).
//
// Usage:
//   write-release-record.ts --release <name> --head <full commit> --previous <release file> --plan <plan.json>
//        --digests <dir> --root <repository dir> [--scans <dir>] [--jobs <jobs.json>] [--run-url <url>]
//        [--base <commit>] [--dry-run]
//
// --digests  a directory holding one JSON file per pushed image: {"key","reference","sourceCommit"}
// --scans    a directory of downloaded scan artifacts (see SCAN_LOCATIONS); optional
// --jobs     the output of `gh run view --json jobs`; optional
// --dry-run  check everything that can be checked without digests (the plan, the previous record,
//            the migrations, the notes) and write nothing; used by a run that publishes nothing
//
// It refuses (exit 1, nothing written) when the release name is malformed, when a file for that
// release already exists, or when the digests do not match the plan exactly. It never fills in an
// image it was not given a digest for.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Where a scan artifact keeps the report of each image, relative to the downloaded artifacts. */
export const SCAN_LOCATIONS: Record<string, string> = {
  "chief-of-staff": "runtime-chief-of-staff-image-scan/runtime/scan.json",
  creative: "runtime-creative-image-scan/runtime/scan.json",
  "lares-keeper": "keeper-and-network-image-scans/keeper/scan.json",
  "lares-egress-proxy": "keeper-and-network-image-scans/egress/scan.json",
  "lares-firewall-helper": "keeper-and-network-image-scans/firewall/scan.json",
  console: "console-image-scan/console/scan.json",
  "sync-jobs": "sync-jobs-image-scan/sync-jobs/scan.json",
};

function fail(problem: string): never {
  process.stderr.write(`write-release-record: ${problem}\n`);
  process.exit(1);
}

function highest(dir: string, pattern: RegExp): string {
  const names = readdirSync(dir).filter((name) => pattern.test(name)).sort();
  if (names.length === 0) fail(`no file in ${dir} matches ${pattern}`);
  return names[names.length - 1]!;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (!["--release", "--head", "--previous", "--plan", "--digests", "--root", "--scans", "--jobs", "--run-url", "--base"].includes(arg)) fail(`unknown argument "${arg}"`);
    const value = args[i + 1];
    if (value === undefined || values.has(arg)) fail(`${arg} needs one value`);
    values.set(arg, value);
    i += 1;
  }
  for (const needed of ["--release", "--head", "--previous", "--plan", "--digests", "--root"]) if (!values.has(needed)) fail(`${needed} is needed`);

  const record = await import(pathToFileURL(join(here, "..", "lib", "release-record.ts")).href);
  const planLib = await import(pathToFileURL(join(here, "..", "lib", "release-plan.ts")).href);
  const manifestLib = await import(pathToFileURL(join(here, "..", "lib", "release-manifest.ts")).href);

  const release = values.get("--release")!;
  const head = values.get("--head")!;
  const root = resolve(values.get("--root")!);
  const short = record.shortName(release);
  const releaseFile = join(root, "releases", `${release}.json`);
  const notesFile = join(root, "docs", "releases", `${short}-notes.md`);
  if (existsSync(releaseFile) || existsSync(notesFile)) fail(`a record for ${release} already exists (${existsSync(releaseFile) ? releaseFile : notesFile})`);
  if (!/^[a-f0-9]{40}$/.test(head)) fail("--head must be a full commit id");

  const previous = manifestLib.parseReleaseManifest(readFileSync(values.get("--previous")!, "utf8"));
  const plan = JSON.parse(readFileSync(values.get("--plan")!, "utf8")) as { head: string; rows: import("../lib/release-plan.js").PlanRow[] };
  if (plan.head !== head) fail(`the plan was made for ${plan.head}, not for ${head}`);

  const digests: import("../lib/release-plan.js").PublishedDigest[] = [];
  const digestDir = resolve(values.get("--digests")!);
  if (!dryRun) {
    if (!existsSync(digestDir)) fail(`the digest directory ${digestDir} does not exist`);
    for (const name of readdirSync(digestDir).filter((entry) => entry.endsWith(".json")).sort()) {
      digests.push(JSON.parse(readFileSync(join(digestDir, name), "utf8")));
    }
  }

  let assembled: { images: Record<string, string>; sources: Record<string, string> };
  if (dryRun) {
    // No digests exist in a run that publishes nothing: check what can be checked, with placeholders
    // that are never written anywhere.
    const fake = plan.rows.filter((row) => row.action === "build").map((row) => ({ key: row.key, reference: `ghcr.io/example/${row.key}@sha256:${"0".repeat(64)}`, sourceCommit: head }));
    assembled = planLib.assembleImages(previous, plan.rows, fake, head);
  } else {
    try {
      assembled = planLib.assembleImages(previous, plan.rows, digests, head);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  for (const reference of Object.values(assembled.images)) {
    if (!manifestLib.DIGEST_REFERENCE.test(reference)) fail(`"${reference}" is not an image named by digest`);
  }

  const migrations: { box: string; chiefOfStaff?: string } = { box: highest(join(root, "services", "box", "sql"), /\.sql$/) };
  if (previous.migrations.chiefOfStaff !== undefined) migrations.chiefOfStaff = highest(join(root, "services", "chief-of-staff", "sql"), /\.sql$/);

  const scans: Record<string, { critical: number; high: number }> = {};
  if (values.has("--scans")) {
    for (const [key, location] of Object.entries(SCAN_LOCATIONS)) {
      const file = join(resolve(values.get("--scans")!), location);
      if (existsSync(file)) scans[key] = record.countFindings(readFileSync(file, "utf8"));
    }
  }
  let jobs: { name: string; conclusion: string }[] = [];
  if (values.has("--jobs")) {
    const parsed = JSON.parse(readFileSync(values.get("--jobs")!, "utf8")) as { jobs?: { name?: string; conclusion?: string }[] };
    jobs = (parsed.jobs ?? []).filter((job) => typeof job.name === "string").map((job) => ({ name: job.name!, conclusion: job.conclusion ?? "still running" }));
  }

  // The commits since the previous release: from the newest commit that release records for an image, else --base.
  let changes: string[] | null = null;
  let changesBase: string | null = null;
  const candidates: string[] = [...new Set<string>([...(Object.values(previous.sources ?? {}) as string[]), ...(values.has("--base") && values.get("--base") !== "" ? [values.get("--base")!] : [])])];
  try {
    if (candidates.length > 0) {
      changesBase = execFileSync("git", ["-C", root, "rev-list", "--no-walk=sorted", "--max-count=1", ...candidates], { encoding: "utf8" }).trim();
      changes = execFileSync("git", ["-C", root, "log", "--format=%s", `${changesBase}..${head}`], { encoding: "utf8" }).split("\n").filter((line) => line !== "");
    }
  } catch {
    changes = null;
    changesBase = null;
  }

  const facts = {
    release,
    head,
    previous,
    rows: plan.rows,
    images: assembled.images,
    sources: assembled.sources,
    migrations,
    scans,
    jobs,
    runUrl: values.get("--run-url") ?? "",
    changes,
    changesBase,
    today: new Date().toISOString().slice(0, 10),
  };
  const fileText: string = record.releaseFileText(facts);
  manifestLib.parseReleaseManifest(fileText); // what is written must be a release the installer accepts
  const notesText: string = record.releaseNotesText(facts);

  if (dryRun) {
    process.stdout.write(`dry run: would write ${releaseFile} (${Object.keys(assembled.images).length} images) and ${notesFile}; nothing was written\n`);
    return;
  }
  writeFileSync(releaseFile, fileText);
  writeFileSync(notesFile, notesText);
  process.stdout.write(`wrote ${releaseFile} and ${notesFile}\n`);
}

// Run only as a program: the tests import SCAN_LOCATIONS without starting it.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
