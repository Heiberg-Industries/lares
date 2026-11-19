// services/box/bin/plan-release.ts — decides, for a new test release, which images are built and
// which are carried over from the previous release record (lib/release-plan.ts).
//
// Usage:
//   plan-release.ts --previous <release file> --head <full commit> --out <dir> [--base <commit>] [--repo <dir>]
//
// --previous  the release file of the last recorded release
// --head      the commit this release is built from
// --base      used only for an image the previous file records no source commit for; without it
//             such an image is built
// --out       a directory; it receives `plan.json`, `outputs` (name=value lines for $GITHUB_OUTPUT)
//             and `summary.md` (a table for the run summary)
//
// It asks the selector (bin/affected-images.ts) as its own process, once per distinct base. Any
// doubt builds the image. It exits 0 with a complete answer, and non-zero (2) only for a wrong
// command line or a previous file it cannot read, in which case it writes nothing and the
// workflow stops. Runs under plain `node`, like bin/images-to-build.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Files that make this program's own answer: a change to one is a reason to build everything. */
export const OWN_PATHS = ["services/box/bin/plan-release.ts", "services/box/lib/release-plan.ts"] as const;

function usage(problem: string): never {
  process.stderr.write(
    `plan-release: ${problem}\nusage: plan-release.ts --previous <release file> --head <full commit> --out <dir> [--base <commit>] [--repo <dir>]\n`,
  );
  process.exit(2);
}

type Verdict = import("../lib/release-plan.js").Verdict;

/** Runs the selector for base..head and reads its answer in full. Throws on anything else. */
export function askSelector(repo: string, head: string, base: string): Map<string, Verdict> {
  const printed = execFileSync(process.execPath, [join(here, "affected-images.ts"), "--base", base, "--head", head, "--repo", repo], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60 * 1000,
  });
  const parsed: unknown = JSON.parse(printed);
  if (typeof parsed !== "object" || parsed === null) throw new Error("the selector's answer is not a JSON object");
  const selection = parsed as Record<string, unknown>;
  if (typeof selection.all !== "boolean") throw new Error('the selector\'s answer has no true or false "all"');
  if (!Array.isArray(selection.changed) || !Array.isArray(selection.images)) throw new Error("the selector's answer lacks its lists");
  const changed = selection.changed as unknown[];
  const everything = (reason: string): Map<string, Verdict> => new Map((selection.images as { image?: unknown }[]).map((entry) => [String(entry.image), { rebuild: true, reason }]));
  if (selection.all) return everything(typeof selection.allBecause === "string" && selection.allBecause !== "" ? selection.allBecause : "the selector answered every image");
  if (changed.some((path) => typeof path === "string" && (OWN_PATHS as readonly string[]).includes(path))) {
    return everything("the program that plans a release changed, so how it reads the selector may have changed with it");
  }
  const verdicts = new Map<string, Verdict>();
  for (const entry of selection.images as Record<string, unknown>[]) {
    if (typeof entry.image !== "string" || typeof entry.rebuild !== "boolean" || typeof entry.reason !== "string") throw new Error("an entry of the selector's answer is not whole");
    if (verdicts.has(entry.image)) throw new Error(`the selector's answer names ${entry.image} twice`);
    verdicts.set(entry.image, { rebuild: entry.rebuild, reason: entry.reason });
  }
  return verdicts;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const arg = args[i]!;
    if (!["--previous", "--head", "--out", "--base", "--repo"].includes(arg)) usage(`unknown argument "${arg}"`);
    const value = args[i + 1];
    if (value === undefined || values.has(arg)) usage(`${arg} needs one value`);
    values.set(arg, value);
  }
  for (const needed of ["--previous", "--head", "--out"]) if (!values.has(needed) || values.get(needed) === "") usage(`${needed} is needed`);

  const repo = resolve(values.get("--repo") ?? join(here, "..", "..", ".."));
  const lib = await import(pathToFileURL(join(here, "..", "lib", "release-plan.ts")).href);
  const manifestLib = await import(pathToFileURL(join(here, "..", "lib", "release-manifest.ts")).href);
  let previous;
  try {
    previous = manifestLib.parseReleaseManifest(readFileSync(values.get("--previous")!, "utf8"));
  } catch (error) {
    usage(`cannot read the previous release file: ${error instanceof Error ? error.message : String(error)}`);
  }

  const head = values.get("--head")!.trim();
  const rows = lib.planRelease({
    previous,
    head,
    fallbackBase: (values.get("--base") ?? "").trim(),
    ask: (base: string) => askSelector(repo, head, base),
  }) as import("../lib/release-plan.js").PlanRow[];

  const out = resolve(values.get("--out")!);
  mkdirSync(out, { recursive: true });
  const selection = lib.selectionFor(rows) as Record<string, boolean>;
  const lines = [
    `selection=${JSON.stringify(selection)}`,
    `keeperRuntime=${lib.groupBuilds(rows, "keeper-runtime")}`,
    `console=${lib.groupBuilds(rows, "console")}`,
    `syncJobs=${lib.groupBuilds(rows, "sync-jobs")}`,
  ];
  const cell = (text: string): string => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  const summary = [
    `Previous release: ${previous.release}. Built from commit ${head}.`,
    "",
    "| image | decision | compared with | reason |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.key} | ${row.action === "build" ? "build" : "carry over"} | ${row.base ?? "-"} | ${cell(row.reason)} |`),
    "",
  ].join("\n");
  writeFileSync(join(out, "plan.json"), `${JSON.stringify({ previous: previous.release, head, rows }, null, 2)}\n`);
  writeFileSync(join(out, "outputs"), `${lines.join("\n")}\n`);
  writeFileSync(join(out, "summary.md"), summary);
  process.stdout.write(`${lines.join("\n")}\n`);
}

// Run only as a program: the tests import askSelector without starting it.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
