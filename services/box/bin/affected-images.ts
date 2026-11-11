// services/box/bin/affected-images.ts — prints, as JSON, which images a change can affect
// (lib/affected-images.ts). Nothing calls this yet; no workflow reads its answer.
//
// Usage:
//   affected-images.ts --base <commit> --head <commit>   the paths that differ between two commits
//   affected-images.ts --stdin                           changed paths on standard input, one per line
//   affected-images.ts --describe                        every image with the inputs worked out for it
//   ... [--repo <dir>]                                   the repository; default: the one this file is in
//   ... [--allow-empty]                                  an empty list of changes is expected: rebuild nothing
//
// An EMPTY list of changes answers "every image" unless --allow-empty is given. An empty list is
// what `git diff ... | affected-images.ts --stdin` receives when the diff failed, and "nothing
// changed, publish the old images" must never be the answer to a failure. Pass --allow-empty only
// where the caller has itself established that the two commits hold the same files.
//
// With --base/--head the Dockerfiles and package.json files are read from <head> itself, not from
// the files on disk, and the diff is taken WITHOUT rename detection: a renamed file must count as
// one path removed and one path added, or a file moved out of an image would go unnoticed. A caller
// that uses --stdin must list paths the same way (`git diff --name-only --no-renames`); the
// manifests are then read from the files on disk.
//
// The answer is always printed. If git cannot produce the diff, or the selector meets anything it
// does not understand, the answer is "every image", with the reason. Only a wrong command line
// exits non-zero (2), printing nothing on standard output.
//
// It runs under plain `node` with nothing installed, so like bin/update-record.ts it loads the
// library by its real `.ts` file name, relative to this file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Lib = typeof import("../lib/affected-images.js");
type RepoReader = import("../lib/affected-images.js").RepoReader;

const here = dirname(fileURLToPath(import.meta.url));

function usage(problem: string): never {
  process.stderr.write(
    `affected-images: ${problem}\n` +
      "usage: affected-images.ts (--base <commit> --head <commit> | --stdin | --describe) [--repo <dir>] [--allow-empty]\n",
  );
  process.exit(2);
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** The tree of one commit, read through git: what the repository holds at that commit, whatever is on disk. */
function commitReader(repo: string, commit: string): RepoReader {
  const files = new Set(git(repo, ["ls-tree", "-r", "-z", "--name-only", commit]).split("\0").filter((path) => path !== ""));
  const dirs = new Set<string>();
  for (const file of files) {
    for (let slash = file.indexOf("/"); slash >= 0; slash = file.indexOf("/", slash + 1)) dirs.add(file.slice(0, slash));
  }
  const cache = new Map<string, string>();
  return {
    readFile(path) {
      if (!files.has(path)) return null;
      if (!cache.has(path)) cache.set(path, git(repo, ["show", `${commit}:${path}`]));
      return cache.get(path)!;
    },
    listDirs(path) {
      const prefix = path === "." ? "" : `${path}/`;
      const names = new Set<string>();
      for (const dir of dirs) {
        if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/") && dir.length > prefix.length) names.add(dir.slice(prefix.length));
      }
      return [...names];
    },
    exists(path) {
      return files.has(path) || dirs.has(path);
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let allowEmpty = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--stdin" || arg === "--describe") flags.add(arg);
    else if (arg === "--allow-empty") allowEmpty = true;
    else if (arg === "--base" || arg === "--head" || arg === "--repo") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--") || values.has(arg)) usage(`${arg} needs one value`);
      values.set(arg, value);
      i += 1;
    } else usage(`unknown argument "${arg}"`);
  }
  const byCommits = values.has("--base") || values.has("--head");
  if (Number(byCommits) + flags.size !== 1) usage("give exactly one of --base/--head, --stdin or --describe");
  if (byCommits && !(values.has("--base") && values.has("--head"))) usage("--base and --head go together");
  if (allowEmpty && flags.has("--describe")) usage("--allow-empty says nothing to --describe");

  const repo = resolve(values.get("--repo") ?? join(here, "..", "..", ".."));
  const lib: Lib = await import(pathToFileURL(join(here, "..", "lib", "affected-images.ts")).href);
  const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };

  if (flags.has("--describe")) {
    print(lib.describeImages(lib.fsRepoReader(repo)));
    return;
  }
  if (flags.has("--stdin")) {
    const paths = readFileSync(0, "utf8").split(/\r?\n|\0/).filter((line) => line.trim() !== "");
    print(lib.selectAffectedImagesOrAll(paths, lib.fsRepoReader(repo), lib.IMAGES, { allowEmpty }));
    return;
  }

  const base = values.get("--base")!;
  const head = values.get("--head")!;
  let paths: string[];
  let reader: RepoReader;
  try {
    // Full commit ids only from here on, so a branch that moves mid-run cannot split the answer.
    const baseCommit = git(repo, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
    const headCommit = git(repo, ["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`]).trim();
    paths = git(repo, ["diff", "--name-only", "--no-renames", "-z", baseCommit, headCommit]).split("\0").filter((path) => path !== "");
    reader = commitReader(repo, headCommit);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    print(lib.everyImage(`git could not list what changed between ${base} and ${head}, so every image is rebuilt: ${detail}`));
    return;
  }
  print(lib.selectAffectedImagesOrAll(paths, reader, lib.IMAGES, { allowEmpty }));
}

await main();
