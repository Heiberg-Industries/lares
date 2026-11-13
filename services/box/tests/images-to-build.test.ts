// images-to-build.test.ts — bin/images-to-build.ts, the script the image workflow's `select`
// job runs to learn which of its five images one change makes it build.
//
// The script is run the way the workflow runs it (plain `node`, as its own process) against a
// throwaway git repository: a copy of this repository's tracked files with one small commit per
// case. What matters most is the second half of this file: whenever the question cannot be
// answered for certain, the answer is "every image" (`all` true, every flag true), with exit 0.
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FLAGS, OWN_PATH, everything, imagesToBuild, outputLines, readSelection, summaryMarkdown, type Answer, type Flag } from "../bin/images-to-build.js";
import { SELECTOR_FILES, fsRepoReader, selectAffectedImages, type Selection } from "../lib/affected-images.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO, "services", "box", "bin", "images-to-build.ts");
const WORKFLOW = ".github/workflows/keeper-runtime-images.yml";
const KEYS = ["all", "because", "chiefRuntime", "creativeRuntime", "keeper", "firewallHelper", "egressProxy", "anyKeeperFamily"];
const ALL_FLAGS = [...FLAGS.map(({ flag }) => flag), "anyKeeperFamily"].sort();

/** The flags that are true, by name. */
const built = (answer: Answer): string[] => ALL_FLAGS.filter((flag) => answer[flag as Flag | "anyKeeperFamily"]);

/** "Every image", in full: nothing about the answer leaves room to skip a build. */
function expectEverything(answer: Answer, because: RegExp): void {
  expect(Object.keys(answer)).toEqual(KEYS);
  expect(answer.all).toBe(true);
  expect(built(answer)).toEqual(ALL_FLAGS);
  expect(answer.because).toMatch(because);
}

let work = "";
/** One commit per name, each changing exactly the one path that goes with it in `changedBy`. */
const commits: Record<string, string> = {};
const changedBy: Record<string, string> = {
  readme: "README.md",
  egress: "images/egress-proxy/Dockerfile",
  docs: "docs/a-page-for-this-test.md",
  box: "services/box/tests/a-file-for-this-test.test.ts",
  creative: "services/creative/package.json",
  workflow: WORKFLOW,
  unknown: "a-new-top-level-file.txt",
  ownScript: OWN_PATH,
  selector: SELECTOR_FILES[1]!,
};

// git in the throwaway repository only: no configuration of the machine reaches it.
const hermetic = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const git = (args: string[]): string => execFileSync("git", ["-C", work, ...args], { encoding: "utf8", env: hermetic, maxBuffer: 64 * 1024 * 1024 });
const commit = (message: string): string => {
  // Everything in the directory, ignored or not: the directory holds nothing but this test's files.
  git(["add", "--all", "--force"]);
  git(["commit", "--quiet", "--no-gpg-sign", "--allow-empty", "--message", message]);
  return git(["rev-parse", "HEAD"]).trim();
};

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "images-to-build-"));
  const tracked = execFileSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter((path) => path !== "");
  for (const path of tracked) {
    if (!existsSync(join(REPO, path))) continue; // deleted in the working tree
    mkdirSync(dirname(join(work, path)), { recursive: true });
    cpSync(join(REPO, path), join(work, path));
  }
  git(["init", "--quiet", "--initial-branch", "main"]);
  commits.start = commit("the repository as it is");
  for (const [name, path] of Object.entries(changedBy)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    // One more line at the end: a real change that leaves every file as readable as it was.
    appendFileSync(join(work, path), path.endsWith(".json") ? "\n" : "\n# one more line, for a test\n");
    commits[name] = commit(`change ${path}`);
  }
}, 120_000);

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

function run(args: string[]): { status: number; out: string; err: string } {
  try {
    // Plain `node`, as the workflow runs it before anything is installed.
    return { status: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }), err: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, out: failure.stdout ?? "", err: failure.stderr ?? "" };
  }
}

/** The script's answer for two commits of the throwaway repository. It must always exit 0. */
function ask(base: string, head: string, repo = work): Answer {
  const { status, out } = run(["--base", base, "--head", head, "--repo", repo]);
  expect(status).toBe(0);
  return JSON.parse(out) as Answer;
}

/** The commit just before the one that changed `name`'s path: between the two, only that path differs. */
const before = (name: string): string => `${commits[name]}~1`;

/** What the selector's library says about one changed path, as flags. */
function libraryFlags(path: string): string[] {
  const selection = selectAffectedImages([path], fsRepoReader(work));
  const rebuild = (image: string): boolean => selection.images.find((entry) => entry.image === image)!.rebuild;
  const flags: string[] = FLAGS.filter(({ image }) => rebuild(image)).map(({ flag }) => flag);
  if (["keeper", "firewall-helper", "egress-proxy"].some(rebuild)) flags.push("anyKeeperFamily");
  return flags.sort();
}

describe("images-to-build: a change the selector can place", { timeout: 60_000 }, () => {
  it("runs under plain node and loads nothing but Node's own modules", () => {
    const imports = [...readFileSync(SCRIPT, "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier).toMatch(/^node:/);
  });

  it("builds only the egress proxy when only its Dockerfile changed", () => {
    const answer = ask(before("egress"), commits.egress!);
    expect(Object.keys(answer)).toEqual(KEYS);
    expect(answer.all).toBe(false);
    expect(built(answer)).toEqual(["anyKeeperFamily", "egressProxy"]);
    expect(answer.because).toBe("1 changed path; rebuild: egress-proxy; keep: chief-of-staff-runtime, creative-runtime, keeper, firewall-helper");
  });

  it("builds none of the five for a change that is in none of them", () => {
    const answer = ask(before("readme"), commits.readme!);
    expect(Object.keys(answer)).toEqual(KEYS);
    expect(answer.all).toBe(false);
    expect(built(answer)).toEqual([]);
    for (const flag of ALL_FLAGS) expect(answer[flag as Flag | "anyKeeperFamily"]).toBe(false);
    expect(answer.because).toBe("1 changed path; rebuild: none; keep: chief-of-staff-runtime, creative-runtime, keeper, firewall-helper, egress-proxy");
  });

  it.each(["readme", "egress", "docs", "box", "creative", "workflow"])("gives each image the selector's own decision (%s)", (name) => {
    const answer = ask(before(name), commits[name]!);
    expect(answer.all).toBe(false);
    expect(built(answer)).toEqual(libraryFlags(changedBy[name]!));
  });

  it("builds one role's runtime without the other when the selector says so", () => {
    // What the two roles' images take from the repository differs: here a file that only the
    // creative role's image holds, then one that only the chief-of-staff role's image holds.
    const creative = ask(before("creative"), commits.creative!);
    expect(creative.creativeRuntime).toBe(true);
    expect(creative.chiefRuntime).toBe(false);
    const box = ask(before("box"), commits.box!);
    expect(box.chiefRuntime).toBe(true);
    expect(box.creativeRuntime).toBe(false);
  });

  it("builds all five when the workflow that builds them changed", () => {
    expect(built(ask(before("workflow"), commits.workflow!))).toEqual(ALL_FLAGS);
  });

  it("counts every commit between base and head, not only the last", () => {
    // readme, then egress: one range holding both changes.
    const answer = ask(commits.start!, commits.egress!);
    expect(answer.all).toBe(false);
    expect(built(answer)).toEqual(["anyKeeperFamily", "egressProxy"]);
    expect(answer.because).toMatch(/^2 changed paths; /);
  });

  it("takes a ref as well as a commit id", () => {
    git(["tag", "the-base", before("egress")]);
    expect(built(ask("the-base", commits.egress!))).toEqual(["anyKeeperFamily", "egressProxy"]);
  });

  it("writes the flags as output lines and a table for the run summary", () => {
    const outputs = join(work, "..", `${Date.now()}-outputs`);
    const summary = `${outputs}.md`;
    try {
      const { status, out } = run(["--base", before("egress"), "--head", commits.egress!, "--repo", work, "--outputs", outputs, "--summary", summary]);
      expect(status).toBe(0);
      const answer = JSON.parse(out) as Answer;
      expect(readFileSync(outputs, "utf8")).toBe("all=false\nchiefRuntime=false\ncreativeRuntime=false\nkeeper=false\nfirewallHelper=false\negressProxy=true\nanyKeeperFamily=true\n");
      expect(readFileSync(outputs, "utf8")).toBe(outputLines(answer));
      const table = readFileSync(summary, "utf8");
      expect(table).toContain("| image | decision | reason |");
      expect(table).toContain("| egress-proxy | rebuild | images/egress-proxy/Dockerfile is the Dockerfile egress-proxy is built from |");
      expect(table).toContain("| keeper | keep | no changed file is an input of this image |");
      expect(table.match(/^\| (chief-of-staff-runtime|creative-runtime|keeper|firewall-helper|egress-proxy) \| (rebuild|keep) \| /gm)).toHaveLength(5);
      expect(table).toContain('An image marked "keep" is not built, probed or pushed by this run.');
    } finally {
      rmSync(outputs, { force: true });
      rmSync(summary, { force: true });
    }
  });
});

describe("images-to-build: doubt builds every image", { timeout: 60_000 }, () => {
  it("builds everything when no base is given", () => {
    expectEverything(ask("", commits.egress!), /^no base commit was given/);
    expectEverything(ask("   ", commits.egress!), /^no base commit was given/);
  });

  it("builds everything for a base of all zeros, which is what a new branch gives", () => {
    expectEverything(ask("0000000000000000000000000000000000000000", commits.egress!), /^the base commit is all zeros \(a new branch\)/);
  });

  it("builds everything when the base is not a commit git knows", () => {
    expectEverything(ask("no-such-commit", commits.egress!), /git could not list what changed between no-such-commit and /);
    expectEverything(ask("1234567890123456789012345678901234567890", commits.egress!), /git could not list what changed/);
  });

  it("builds everything when the head is missing or not a commit git knows", () => {
    expectEverything(ask(commits.start!, "no-such-commit"), /git could not list what changed between .* and no-such-commit/);
    expectEverything(ask(commits.start!, ""), /^no head commit was given/);
  });

  it("builds everything when the repository cannot be read", () => {
    expectEverything(ask(commits.start!, commits.egress!, join(work, "there-is-no-such-directory")), /git could not list what changed/);
    const notARepository = mkdtempSync(join(tmpdir(), "images-to-build-empty-"));
    try {
      expectEverything(ask(commits.start!, commits.egress!, notARepository), /git could not list what changed/);
    } finally {
      rmSync(notARepository, { recursive: true, force: true });
    }
  });

  it("builds everything when base and head are the same commit: an empty difference is also what a failure looks like", () => {
    expectEverything(ask(commits.egress!, commits.egress!), /the list of changed files is empty/);
  });

  it("builds everything when a changed path is one no rule places", () => {
    expectEverything(ask(before("unknown"), commits.unknown!), /^unknown path: a-new-top-level-file\.txt/);
  });

  it("builds everything when the selector itself changed", () => {
    expectEverything(ask(before("selector"), commits.selector!), /^the selector itself changed/);
  });

  it("builds everything when this script itself changed", () => {
    expectEverything(ask(before("ownScript"), commits.ownScript!), /^the script that reads the selector's answer changed \(services\/box\/bin\/images-to-build\.ts\)/);
    // The same from the function, with nothing else among the changes that would say so.
    const selection = JSON.parse(JSON.stringify(selectAffectedImages([OWN_PATH, "README.md"], fsRepoReader(work)))) as Selection;
    expect(selection.all).toBe(false);
    expectEverything(readSelection(JSON.stringify(selection)).answer, /^the script that reads the selector's answer changed/);
  });

  describe("a selector that fails, or answers something else", () => {
    /** A stand-in for the selector: a program that does only what `body` says. */
    const standIn = (name: string, body: string): string => {
      const file = join(work, "..", `${Date.now()}-${name}.mjs`);
      writeFileSync(file, body);
      return file;
    };
    const answerWith = (name: string, body: string): Answer => {
      const selector = standIn(name, body);
      try {
        return imagesToBuild({ base: commits.start!, head: commits.egress!, repo: work, selector }).answer;
      } finally {
        rmSync(selector, { force: true });
      }
    };
    /** A real answer of the selector that keeps all five, for the cases below to damage. (From this repository: the tables below are filled in before the throwaway one exists.) */
    const kept = (): Selection => JSON.parse(JSON.stringify(selectAffectedImages(["README.md"], fsRepoReader(REPO)))) as Selection;
    const printing = (value: unknown): string => `process.stdout.write(${JSON.stringify(typeof value === "string" ? value : JSON.stringify(value))});`;

    it("takes the stand-in's answer when it is a whole one, so the cases below prove something", () => {
      const answer = answerWith("whole", printing(kept()));
      expect(answer.all).toBe(false);
      expect(built(answer)).toEqual([]);
    });

    it.each([
      ["exits 1", "process.exit(1);", /^the selector exited with status 1, so every image is built/],
      ["exits 2, as for a wrong command line", "process.stderr.write('usage: ...\\n'); process.exit(2);", /^the selector exited with status 2, so every image is built: usage: \.\.\./],
      ["prints a whole answer and then fails", `${printing(kept())} process.exit(3);`, /^the selector exited with status 3/],
      ["throws", "throw new Error('broken');", /^the selector exited with status 1/],
      ["is stopped by a signal", "process.kill(process.pid, 'SIGKILL');", /^the selector was stopped by SIGKILL/],
    ])("builds everything when the selector %s", (name, body, because) => {
      expectEverything(answerWith(name.replace(/\W+/g, "-"), body), because);
    });

    it("builds everything when the selector is not there to run", () => {
      expectEverything(imagesToBuild({ base: commits.start!, head: commits.egress!, repo: work, selector: join(work, "no-such-selector.ts") }).answer, /^the selector exited with status 1, so every image is built/);
    });

    it.each<[string, (selection: any) => unknown, RegExp]>([
      ["nothing", () => "", /is not JSON/],
      ["text that is not JSON", () => "rebuild nothing", /is not JSON/],
      ["half an answer", (selection) => JSON.stringify(selection).slice(0, 200), /is not JSON/],
      ["a list", (selection) => [selection], /is not a JSON object/],
      ["null", () => "null", /is not a JSON object/],
      ["no \"all\"", (selection) => ({ ...selection, all: undefined }), /has no true or false "all"/],
      ["\"all\" as a word", (selection) => ({ ...selection, all: "false" }), /has no true or false "all"/],
      ["no list of changed paths", (selection) => ({ ...selection, changed: undefined }), /has no list of "changed" paths/],
      ["no list of images", (selection) => ({ ...selection, images: undefined }), /has no list of "images"/],
      ["an empty list of images", (selection) => ({ ...selection, images: [] }), /names chief-of-staff-runtime 0 times, not once/],
      ["one of the five images missing", (selection) => ({ ...selection, images: selection.images.filter((entry: any) => entry.image !== "firewall-helper") }), /names firewall-helper 0 times, not once/],
      ["one of the five images twice", (selection) => ({ ...selection, images: [...selection.images, selection.images.find((entry: any) => entry.image === "keeper")] }), /names keeper 2 times, not once/],
      ["no decision for an image", (selection) => ({ ...selection, images: selection.images.map((entry: any) => (entry.image === "keeper" ? { ...entry, rebuild: undefined } : entry)) }), /does not say rebuild or keep for keeper/],
      ["a decision that is a word", (selection) => ({ ...selection, images: selection.images.map((entry: any) => (entry.image === "egress-proxy" ? { ...entry, rebuild: "false" } : entry)) }), /does not say rebuild or keep for egress-proxy/],
      ["no reason for an image", (selection) => ({ ...selection, images: selection.images.map((entry: any) => (entry.image === "creative-runtime" ? { ...entry, reason: "" } : entry)) }), /gives no reason for creative-runtime/],
    ])("builds everything when the selector prints %s", (name, damage, because) => {
      const text = ((value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value)))(damage(kept()));
      expect(() => readSelection(text)).toThrow(because);
      expectEverything(answerWith(name.replace(/\W+/g, "-"), printing(text)), new RegExp(`^the selector's answer could not be used, so every image is built: .*${because.source}`));
    });

    it("builds everything when the selector says every image, even if its list says keep", () => {
      const selection = { ...kept(), all: true, allBecause: "the selector could not be sure" };
      expect(FLAGS.every(({ image }) => !selection.images.find((entry) => entry.image === image)!.rebuild)).toBe(true);
      expectEverything(readSelection(JSON.stringify(selection)).answer, /^the selector could not be sure$/);
      expectEverything(readSelection(JSON.stringify({ ...selection, allBecause: null })).answer, /^the selector answered every image, without a reason$/);
    });
  });

  it("says the same in the output lines and the summary as in the answer", () => {
    const result = everything("a reason | with a bar\nand a second line");
    expect(outputLines(result.answer)).toBe("all=true\nchiefRuntime=true\ncreativeRuntime=true\nkeeper=true\nfirewallHelper=true\negressProxy=true\nanyKeeperFamily=true\n");
    const table = summaryMarkdown(result);
    expect(table).toContain("Every image is built and probed: a reason \\| with a bar and a second line");
    expect(table.match(/^\| \S+ \| rebuild \| a reason \\\| with a bar and a second line \|$/gm)).toHaveLength(5);
    expect(table).not.toContain("| keep |");
  });

  it("still answers every image, and exits 0, when the output files cannot be written", () => {
    const { status, out } = run(["--base", before("readme"), "--head", commits.readme!, "--repo", work, "--outputs", join(work, "no-such-directory", "outputs")]);
    expect(status).toBe(0);
    expectEverything(JSON.parse(out) as Answer, /^the answer could not be written down, so every image is built/);
  });

  it.each([
    [[]],
    [["--base", "HEAD"]],
    [["--head", "HEAD"]],
    [["--base", "HEAD", "--head"]],
    [["--bogus"]],
    [["--base", "HEAD", "--head", "HEAD", "--bogus", "x"]],
    [["--base", "HEAD", "--head", "HEAD", "--base", "HEAD"]],
    [["--base", "HEAD", "--head", "HEAD", "--repo", ""]],
    [["--base", "HEAD", "--head", "HEAD", "--outputs", ""]],
    [["HEAD", "HEAD"]],
  ])("refuses a wrong command line %j with exit 2 and no answer", (args) => {
    const { status, out, err } = run(args);
    expect(status).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("usage: images-to-build.ts");
  });
});
