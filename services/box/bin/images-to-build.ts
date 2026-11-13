// services/box/bin/images-to-build.ts — which of the five images of the workflow "keeper and
// neutral runtime images" one change makes it build, probe and publish. It asks the selector
// (bin/affected-images.ts) about two commits and turns the answer into one flag per image, for
// the workflow's `select` job to hand to the jobs that build.
//
// Usage:
//   images-to-build.ts --base <commit-or-empty> --head <commit>
//   ... [--repo <dir>]       the repository; default: the one this file is in
//   ... [--outputs <file>]   also write the flags as `name=value` lines (the form of $GITHUB_OUTPUT)
//   ... [--summary <file>]   also write a table: image, rebuild or keep, reason
//
// It prints one JSON object:
//   { "all", "because", "chiefRuntime", "creativeRuntime", "keeper", "firewallHelper",
//     "egressProxy", "anyKeeperFamily" }
//
// The rule that matters: a flag is false ONLY when the selector answered, for these two commits,
// that the image is kept, and that answer could be read in full. Anything else answers "every
// image" (`all` true, every flag true) with the reason in `because`: no base, a base of all zeros
// (a new branch), a commit git does not know, a selector that fails or prints something else, an
// image missing from its answer, a change to this file, any exception. It still exits 0 then, so
// a failed step cannot be mistaken for "nothing to build". Only a wrong command line exits
// non-zero (2), printing nothing on standard output; the workflow builds everything for that too.
//
// It runs under plain `node` with nothing installed and loads no library: the selector is run as
// its own process, exactly as a person would run it.
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** This file, as the selector names paths. A change to it rebuilds everything: how the answer is read may have changed. */
export const OWN_PATH = "services/box/bin/images-to-build.ts";

/** The images this workflow builds, by the selector's id, each with the flag the workflow reads. */
export const FLAGS = [
  { flag: "chiefRuntime", image: "chief-of-staff-runtime" },
  { flag: "creativeRuntime", image: "creative-runtime" },
  { flag: "keeper", image: "keeper" },
  { flag: "firewallHelper", image: "firewall-helper" },
  { flag: "egressProxy", image: "egress-proxy" },
] as const;

export type Flag = (typeof FLAGS)[number]["flag"];

export type Answer = {
  /** True when every image is built because the question could not be answered for certain. */
  all: boolean;
  because: string;
  /** True when keeper, firewallHelper or egressProxy is: the keeper job proves the three together. */
  anyKeeperFamily: boolean;
} & Record<Flag, boolean>;

export interface Row {
  readonly image: string;
  readonly rebuild: boolean;
  readonly reason: string;
}

/** The answer, and one row per image for the run summary. */
export interface Result {
  readonly answer: Answer;
  readonly rows: readonly Row[];
}

function answerOf(all: boolean, because: string, rebuild: (image: string) => boolean): Answer {
  const flags = Object.fromEntries(FLAGS.map(({ flag, image }) => [flag, all || rebuild(image)])) as Record<Flag, boolean>;
  return {
    all,
    because,
    chiefRuntime: flags.chiefRuntime,
    creativeRuntime: flags.creativeRuntime,
    keeper: flags.keeper,
    firewallHelper: flags.firewallHelper,
    egressProxy: flags.egressProxy,
    anyKeeperFamily: flags.keeper || flags.firewallHelper || flags.egressProxy,
  };
}

/** Every image, for one stated reason. The answer to any doubt. */
export function everything(because: string): Result {
  return { answer: answerOf(true, because, () => true), rows: FLAGS.map(({ image }) => ({ image, rebuild: true, reason: because })) };
}

function refuse(problem: string): never {
  throw new Error(problem);
}

/**
 * Reads what the selector printed. Throws on anything that is not exactly the expected answer;
 * `imagesToBuild` turns that into "every image".
 */
export function readSelection(text: string): Result {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse("the selector's answer is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) refuse("the selector's answer is not a JSON object");
  const selection = parsed as Record<string, unknown>;
  if (typeof selection.all !== "boolean") refuse('the selector\'s answer has no true or false "all"');
  if (!Array.isArray(selection.changed) || selection.changed.some((path) => typeof path !== "string")) refuse('the selector\'s answer has no list of "changed" paths');
  if (!Array.isArray(selection.images)) refuse('the selector\'s answer has no list of "images"');

  const decisions = new Map<string, Row>();
  for (const { image } of FLAGS) {
    const found = selection.images.filter((entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).image === image) as Record<string, unknown>[];
    if (found.length !== 1) refuse(`the selector's answer names ${image} ${found.length} times, not once`);
    const { rebuild, reason } = found[0]!;
    if (typeof rebuild !== "boolean") refuse(`the selector's answer does not say rebuild or keep for ${image}`);
    if (typeof reason !== "string" || reason === "") refuse(`the selector's answer gives no reason for ${image}`);
    decisions.set(image, { image, rebuild, reason });
  }

  if (selection.all) {
    return everything(typeof selection.allBecause === "string" && selection.allBecause !== "" ? selection.allBecause : "the selector answered every image, without a reason");
  }
  if (selection.changed.includes(OWN_PATH)) {
    return everything(`the script that reads the selector's answer changed (${OWN_PATH}), so how it is read may have changed with it: every image is built`);
  }
  const rows = FLAGS.map(({ image }) => decisions.get(image)!);
  const names = (rebuild: boolean): string => rows.filter((row) => row.rebuild === rebuild).map((row) => row.image).join(", ") || "none";
  const because = `${selection.changed.length} changed ${selection.changed.length === 1 ? "path" : "paths"}; rebuild: ${names(true)}; keep: ${names(false)}`;
  return { answer: answerOf(false, because, (image) => decisions.get(image)!.rebuild), rows };
}

export interface Question {
  /** The last commit whose images were built and probed; empty, or all zeros, when there is none. */
  readonly base: string;
  readonly head: string;
  readonly repo: string;
  /** The selector program; default: bin/affected-images.ts beside this file. */
  readonly selector?: string;
}

/** The answer for two commits. Never throws: whatever goes wrong answers "every image". */
export function imagesToBuild(question: Question): Result {
  try {
    const base = question.base.trim();
    const head = question.head.trim();
    if (head === "") return everything("no head commit was given, so there is nothing to compare: every image is built");
    if (base === "") return everything("no base commit was given, so there is nothing to compare with: every image is built");
    if (/^0+$/.test(base)) return everything("the base commit is all zeros (a new branch), so there is nothing to compare with: every image is built");
    const selector = question.selector ?? join(here, "affected-images.ts");
    let printed: string;
    try {
      printed = execFileSync(process.execPath, [selector, "--base", base, "--head", head, "--repo", question.repo], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5 * 60 * 1000,
      });
    } catch (error) {
      const failure = error as { status?: number | null; signal?: string | null; stderr?: string; message?: string };
      const how = typeof failure.status === "number" ? `exited with status ${failure.status}` : failure.signal ? `was stopped by ${failure.signal}` : "could not be run";
      const detail = (typeof failure.stderr === "string" && failure.stderr.trim() !== "" ? failure.stderr : String(failure.message ?? error)).trim().split("\n")[0];
      return everything(`the selector ${how}, so every image is built: ${detail}`);
    }
    return readSelection(printed);
  } catch (error) {
    return everything(`the selector's answer could not be used, so every image is built: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The flags as `name=value` lines, the form $GITHUB_OUTPUT takes. */
export function outputLines(answer: Answer): string {
  return [`all=${answer.all}`, ...FLAGS.map(({ flag }) => `${flag}=${answer[flag]}`), `anyKeeperFamily=${answer.anyKeeperFamily}`].map((line) => `${line}\n`).join("");
}

/** The table for the run summary: image, rebuild or keep, reason. */
export function summaryMarkdown(result: Result): string {
  const cell = (text: string): string => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return [
    result.answer.all ? `Every image is built and probed: ${cell(result.answer.because)}` : `Only the images this change affects are built and probed (${cell(result.answer.because)}). An image marked "keep" is not built, probed or pushed by this run.`,
    "",
    "| image | decision | reason |",
    "| --- | --- | --- |",
    ...result.rows.map((row) => `| ${row.image} | ${row.rebuild ? "rebuild" : "keep"} | ${cell(row.reason)} |`),
    "",
  ].join("\n");
}

function usage(problem: string): never {
  process.stderr.write(
    `images-to-build: ${problem}\n` +
      "usage: images-to-build.ts --base <commit-or-empty> --head <commit> [--repo <dir>] [--outputs <file>] [--summary <file>]\n",
  );
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const arg = args[i]!;
    if (!["--base", "--head", "--repo", "--outputs", "--summary"].includes(arg)) usage(`unknown argument "${arg}"`);
    // The value is the next argument whatever it holds: --base is given empty when there is no base.
    const value = args[i + 1];
    if (value === undefined || values.has(arg)) usage(`${arg} needs one value`);
    values.set(arg, value);
  }
  if (!values.has("--base") || !values.has("--head")) usage("--base and --head are both needed (--base may be empty)");
  for (const name of ["--repo", "--outputs", "--summary"]) if (values.get(name) === "") usage(`${name} needs a value that is not empty`);

  const write = (written: Result): void => {
    if (values.has("--outputs")) writeFileSync(values.get("--outputs")!, outputLines(written.answer));
    if (values.has("--summary")) writeFileSync(values.get("--summary")!, summaryMarkdown(written));
  };
  let result = imagesToBuild({ base: values.get("--base")!, head: values.get("--head")!, repo: resolve(values.get("--repo") ?? join(here, "..", "..", "..")) });
  try {
    write(result);
  } catch (error) {
    // Neither file may be left saying less than the printed answer.
    result = everything(`the answer could not be written down, so every image is built: ${error instanceof Error ? error.message : String(error)}`);
    try {
      write(result);
    } catch {
      // The workflow step finds a file missing or incomplete and builds everything.
    }
  }
  process.stdout.write(`${JSON.stringify(result.answer, null, 2)}\n`);
}

// Run only as a program: the tests import the functions above without starting it.
const invoked = process.argv[1] === undefined ? "" : (() => { try { return realpathSync(process.argv[1]!); } catch { return resolve(process.argv[1]!); } })();
if (invoked === realpathSync(fileURLToPath(import.meta.url))) main();
