// Which images can a change affect? (lib/affected-images.ts)
//
// Three kinds of test:
//   1. real cases against this repository's own Dockerfiles, manifests and workflows;
//   2. small trees that exist only in memory, for behaviour the repository does not show today
//      (an image built FROM another, a Dockerfile the selector cannot read);
//   3. guards that fail when the repository moves and the selector's few tables do not:
//      a new Dockerfile, a new published image, a new entry in a workflow's `paths:` filter,
//      a workspace package in no image, a "this is in no image" rule that stopped being true.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DOCKERFILES_NO_WORKFLOW_BUILDS,
  GENERATED_CONTEXT_PATHS,
  IMAGES,
  IN_NO_IMAGE,
  SelectorUnsure,
  WORKFLOWS_THAT_BUILD_NO_IMAGE,
  WORKFLOW_DECLARED_INPUTS,
  describeImages,
  everyImage,
  fsRepoReader,
  selectAffectedImages,
  selectAffectedImagesOrAll,
  type ImageSpec,
  type RepoReader,
  type Selection,
} from "../lib/affected-images.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The working tree, each file read once: the guards ask about thousands of paths. */
function cached(reader: RepoReader): RepoReader {
  const files = new Map<string, string | null>();
  const dirs = new Map<string, string[]>();
  const there = new Map<string, boolean>();
  const once = <T>(map: Map<string, T>, key: string, read: () => T): T => {
    if (!map.has(key)) map.set(key, read());
    return map.get(key)!;
  };
  return {
    readFile: (path) => once(files, path, () => reader.readFile(path)),
    listDirs: (path) => once(dirs, path, () => reader.listDirs(path)),
    exists: (path) => once(there, path, () => reader.exists(path)),
  };
}

const repo = cached(fsRepoReader(REPO));
const tracked = execFileSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0")
  .filter((path) => path !== "");

/** A tree that exists only in memory. */
function memoryRepo(files: Record<string, string>): RepoReader {
  const paths = Object.keys(files);
  return {
    readFile: (path) => files[path] ?? null,
    listDirs(path) {
      const prefix = `${path}/`;
      return [...new Set(paths.filter((file) => file.startsWith(prefix) && file.slice(prefix.length).includes("/")).map((file) => file.slice(prefix.length).split("/")[0]!))];
    },
    exists: (path) => path in files || paths.some((file) => file.startsWith(`${path}/`)),
  };
}

/** The repository as it is, with some files replaced. */
function overlay(base: RepoReader, replaced: Record<string, string>): RepoReader {
  return { ...base, readFile: (path) => replaced[path] ?? base.readFile(path) };
}

const rebuilt = (selection: Selection): string[] => selection.images.filter((image) => image.rebuild).map((image) => image.image).sort();
const reasonFor = (selection: Selection, id: string): string => selection.images.find((image) => image.image === id)!.reason;
const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

const ALL = IMAGES.map((image) => image.id).sort();
/** The seven images whose Dockerfile runs `pnpm install`. */
const INSTALLING = ["chief-of-staff-builder", "chief-of-staff-runtime", "console", "creative-builder", "creative-runtime", "keeper", "sync-jobs"];
/** The four images that carry the public docs corpus. */
const WITH_DOCS = ["chief-of-staff-builder", "chief-of-staff-runtime", "creative-builder", "creative-runtime"];

describe("real changes against this repository", () => {
  // Two images appear in rows that are not about them. That is not a mistake in the rows:
  //   - `console`: services/console/Dockerfile copies the WHOLE repository into its build stage
  //     (`COPY . .`), so every path in the repository is, literally, an input of that build, and
  //     this selector cannot prove that `next build` ignores any of them;
  //   - `keeper`: services/keeper/Dockerfile copies ALL of services/ and packages/ into the image
  //     it ships (`COPY services/ ./services/`), and that image is used for more than keeper's
  //     own dependencies: the engine files an installation unpacks from it include another
  //     service's SQL. So a file under services/ or packages/ is in the keeper image.
  // The test after this table shows the same rows without them once those copies name what they need.
  const cases: { name: string; changed: string[]; rebuild: string[]; because?: Record<string, RegExp>; unknown?: boolean }[] = [
    {
      name: "a change only in the console rebuilds the console, and keeper, which copies every service",
      changed: ["services/console/app/accounts/page.tsx"],
      rebuild: ["console", "keeper"],
      because: {
        console: /services\/console\/app\/accounts\/page\.tsx is in @lares\/console, which services\/console\/Dockerfile installs or builds/,
        keeper: /copied into the image by services\/keeper\/Dockerfile \("COPY services\/ \.\/services\/"\)/,
      },
    },
    {
      name: "a change in agent-kit rebuilds every image that depends on it",
      changed: ["packages/agent-kit/src/public-docs.ts"],
      rebuild: INSTALLING,
      because: {
        "creative-runtime": /copied into the image by services\/creative\/Dockerfile \("COPY packages\/agent-kit packages\/agent-kit"\)/,
        "sync-jobs": /@lares\/notion-sync -> @lares\/agent-box -> @lares\/agent-kit/,
      },
    },
    {
      name: "a change in vault-format reaches every image through agent-kit",
      changed: ["packages/vault-format/package.json"],
      rebuild: INSTALLING,
    },
    {
      name: "the patch rebuilds every image that copies patches/",
      changed: ["patches/eve.patch"],
      rebuild: INSTALLING,
      because: { keeper: /copied into the image by services\/keeper\/Dockerfile \("COPY patches\/ \.\/patches\/"\)/ },
    },
    { name: "the lockfile rebuilds every image that installs", changed: ["pnpm-lock.yaml"], rebuild: INSTALLING },
    { name: "the workspace file rebuilds every image that installs", changed: ["pnpm-workspace.yaml"], rebuild: INSTALLING },
    { name: "the root package.json (patches, overrides) rebuilds every image that installs", changed: ["package.json"], rebuild: INSTALLING },
    {
      // No Dockerfile in this repository is built FROM the runtime base today; the images that are
      // live in other repositories. The in-memory tests below cover an image that is.
      name: "the runtime base's Dockerfile rebuilds the base (and nothing here is built from it)",
      changed: ["images/runtime-base/Dockerfile"],
      rebuild: ["console", "runtime-base"],
      because: { "runtime-base": /is the Dockerfile runtime-base is built from/, console: /copies whole \("COPY \. \."\)/ },
    },
    {
      name: "a docs-only change rebuilds exactly the images that carry the docs corpus",
      changed: ["docs/install.md"],
      rebuild: [...WITH_DOCS, "console"].sort(),
      because: { "chief-of-staff-builder": /sources of the public docs corpus \(\.public-docs-bake\)/, console: /copies whole/ },
    },
    { name: "the docs exporter rebuilds the same images", changed: ["scripts/public-docs.ts"], rebuild: [...WITH_DOCS, "console"].sort() },
    {
      // keeper and sync-jobs copy the file; the console and the chief of staff depend on the
      // package it is in. The chief of staff's Dockerfile copies only two files of that package,
      // so for it this is the dependency link speaking, not the COPY: over-selection, on purpose.
      name: "a database file under services/box/sql rebuilds the images that carry or depend on that package",
      changed: ["services/box/sql/001_baseline.sql"],
      rebuild: ["chief-of-staff-builder", "chief-of-staff-runtime", "console", "keeper", "sync-jobs"],
      because: {
        keeper: /copied into the image by services\/keeper\/Dockerfile \("COPY services\/ \.\/services\/"\)/,
        "sync-jobs": /copied into the image by services\/sync-jobs\/Dockerfile/,
        "chief-of-staff-runtime": /is in @lares\/agent-box, which lares-chief-of-staff depends on/,
      },
    },
    {
      name: "the admission script every runtime copies rebuilds each image that copies it or depends on its package",
      changed: ["services/box/ops/maintenance-admission.sh"],
      rebuild: ["chief-of-staff-builder", "chief-of-staff-runtime", "console", "creative-runtime", "keeper", "sync-jobs"],
    },
    {
      name: "a file only the runtime stage copies rebuilds the runtime images, not the builder images",
      changed: ["images/agent-runtime/start.sh"],
      rebuild: ["chief-of-staff-runtime", "console", "creative-runtime"],
    },
    {
      name: "one role's settings guard rebuilds that role's runtime only",
      changed: ["images/agent-runtime/required-settings-chief-of-staff.sh"],
      rebuild: ["chief-of-staff-runtime", "console"],
    },
    { name: "the console's start script rebuilds the console", changed: ["images/console-runtime/start.sh"], rebuild: ["console"] },
    { name: "the gateway files keeper carries rebuild keeper", changed: ["images/gateway-runtime/start.sh"], rebuild: ["console", "keeper"] },
    { name: "the proxy's own script rebuilds the proxy", changed: ["images/egress-proxy/maintenance-admission.py"], rebuild: ["console", "egress-proxy"] },
    { name: "the firewall helper's Dockerfile rebuilds the firewall helper", changed: ["images/firewall-helper/Dockerfile"], rebuild: ["console", "firewall-helper"] },
    {
      name: "a change in one role rebuilds that role, and keeper, which copies every service",
      changed: ["services/creative/agent.json"],
      rebuild: ["console", "creative-builder", "creative-runtime", "keeper"],
    },
    {
      name: "a role's Dockerfile rebuilds both images built from it",
      changed: ["services/chief-of-staff/Dockerfile"],
      rebuild: ["chief-of-staff-builder", "chief-of-staff-runtime", "console", "keeper"],
    },
    { name: "a scheduled job rebuilds sync-jobs", changed: ["services/atlas/package.json"], rebuild: ["console", "keeper", "sync-jobs"] },
    { name: "a package only the console uses", changed: ["packages/taste/package.json"], rebuild: ["console", "keeper"] },
    {
      name: "a service with a Dockerfile no workflow builds still rebuilds keeper, which copies it",
      changed: ["services/readability/Dockerfile"],
      rebuild: ["console", "keeper"],
    },
    { name: "the image scanner rebuilds every image, since every image workflow names it", changed: ["scripts/scan-image.sh"], rebuild: ALL },
    {
      name: "a release record rebuilds the images of the one workflow that names releases/",
      changed: ["releases/2026-10-21-rc.12.json"],
      rebuild: ["chief-of-staff-runtime", "console", "creative-runtime", "egress-proxy", "firewall-helper", "keeper"],
      because: { keeper: /named as an input by \.github\/workflows\/keeper-runtime-images\.yml/ },
    },
    { name: "an image workflow rebuilds the image it builds", changed: [".github/workflows/sync-jobs-image.yml"], rebuild: ["console", "sync-jobs"] },
    {
      name: "the workflow that builds five images rebuilds those five",
      changed: [".github/workflows/keeper-runtime-images.yml"],
      rebuild: ["chief-of-staff-runtime", "console", "creative-runtime", "egress-proxy", "firewall-helper", "keeper"],
    },
    {
      name: "the tests workflow builds no image: only the whole-context copy is left",
      changed: [".github/workflows/tests.yml"],
      rebuild: ["console"],
      because: { console: /copies whole/ },
    },
    { name: "repository prose is in no image: only the whole-context copy is left", changed: ["README.md", "AGENTS.md", "CHANGELOG.md"], rebuild: ["console"] },
    { name: "integration manifests are in no image", changed: ["integrations/notion/integration.json"], rebuild: ["console"] },
    {
      name: ".dockerignore rebuilds every image built from the repository root",
      changed: [".dockerignore"],
      rebuild: ALL.filter((id) => id !== "runtime-base"),
    },
    {
      name: "an unknown top-level file rebuilds everything",
      unknown: true,
      changed: ["a-new-top-level-file.txt"],
      rebuild: ALL,
      because: { "runtime-base": /unknown path: a-new-top-level-file\.txt/, console: /unknown path: a-new-top-level-file\.txt/ },
    },
    {
      // Two packages' tsconfig files extend it. No rule places it, on purpose: it rarely changes.
      name: "the root tsconfig.json is deliberately not placed, so it rebuilds everything",
      unknown: true,
      changed: ["tsconfig.json"],
      rebuild: ALL,
      because: { keeper: /unknown path: tsconfig\.json/ },
    },
    { name: "a workflow file nobody has classified rebuilds everything", changed: [".github/workflows/a-new-workflow.yml"], rebuild: ALL, unknown: true },
    { name: "a new directory under images/ that no Dockerfile copies rebuilds everything", changed: ["images/a-new-image/start.sh"], rebuild: ALL, unknown: true },
    {
      name: "one unknown path among known ones still rebuilds everything",
      changed: ["services/console/app/accounts/page.tsx", "a-new-top-level-file.txt"],
      rebuild: ALL,
      unknown: true,
    },
    { name: "an empty change list rebuilds nothing", changed: [], rebuild: [] },
  ];

  it.each(cases)("$name", ({ changed, rebuild, because, unknown }) => {
    for (const path of changed) {
      // A row about a real file must name a real file, or it proves nothing.
      if (!/a-new-/.test(path)) expect(tracked, `${path} is not in the repository`).toContain(path);
    }
    const selection = selectAffectedImages(changed, repo);
    expect(rebuilt(selection)).toEqual([...rebuild].sort());
    expect(selection.images.map((image) => image.image)).toEqual(IMAGES.map((image) => image.id));
    for (const image of selection.images) {
      if (image.rebuild) expect(image.reasons.length).toBeGreaterThan(0);
      else expect(image.reason).toBe("no changed file is an input of this image");
    }
    for (const [id, pattern] of Object.entries(because ?? {})) expect(reasonFor(selection, id)).toMatch(pattern);
    // `all` means "could not be sure", not "every image happens to be an input".
    expect(selection.all).toBe(unknown === true);
    expect(selection.unknownPaths.length > 0).toBe(unknown === true);
  });

  it("names every unknown path, and says so on every image", () => {
    const selection = selectAffectedImages(["a-new-top-level-file.txt", "tsconfig.json", "README.md"], repo);
    expect(selection.all).toBe(true);
    expect(selection.unknownPaths).toEqual(["a-new-top-level-file.txt", "tsconfig.json"]);
    expect(selection.allBecause).toMatch(/^unknown path: a-new-top-level-file\.txt, tsconfig\.json/);
    for (const image of selection.images) expect(image.reasons[0]).toBe(selection.allBecause);
  });

  it("gives one reason per changed file, and a one-line summary", () => {
    const selection = selectAffectedImages(["services/console/package.json", "services/console/next.config.mjs", "docs/install.md"], repo);
    const consoleImage = selection.images.find((image) => image.image === "console")!;
    expect(consoleImage.reasons).toHaveLength(3);
    expect(consoleImage.reason).toMatch(/^docs\/install\.md .* \(and 2 more\)$/);
    expect(consoleImage).toMatchObject({ dockerfile: "services/console/Dockerfile", target: null, workflow: ".github/workflows/console-image.yml" });
  });

  it("treats the same path written twice, or with a leading ./, as one path", () => {
    const selection = selectAffectedImages(["./services/console/package.json", "services/console/package.json", "", "  "], repo);
    expect(selection.changed).toEqual(["services/console/package.json"]);
    expect(rebuilt(selection)).toEqual(["console", "keeper"]);
  });

  it("is the console, and only the console, that copies the whole repository", () => {
    const whole = describeImages(repo).images.filter((image) => image.inputs.some((input) => input.kind === "whole-context")).map((image) => image.id);
    expect(whole).toEqual(["console"]);
  });

  it("gives the narrow answers once the two wide copies name what they need", () => {
    // Not a proposal for those Dockerfiles, and not a claim about what keeper needs: the same two
    // files with the wide copies replaced by named directories, to show that the selector reads the
    // Dockerfiles, and that the "in no image" rules then select nothing at all.
    const consoleDockerfile = repo.readFile("services/console/Dockerfile")!;
    const keeperDockerfile = repo.readFile("services/keeper/Dockerfile")!;
    const wideConsole = "\nCOPY . .\n";
    const wideKeeper = "\nCOPY packages/ ./packages/\nCOPY services/ ./services/\n";
    expect(consoleDockerfile).toContain(wideConsole);
    expect(keeperDockerfile).toContain(wideKeeper);
    const narrowed = overlay(repo, {
      "services/console/Dockerfile": consoleDockerfile.replace(
        wideConsole,
        "\nCOPY services/console services/console\nCOPY services/box services/box\nCOPY services/notion-sync services/notion-sync\nCOPY packages packages\n",
      ),
      "services/keeper/Dockerfile": keeperDockerfile.replace(
        wideKeeper,
        "\nCOPY packages/agent-kit ./packages/agent-kit\nCOPY packages/vault-format ./packages/vault-format\nCOPY services/keeper ./services/keeper\nCOPY services/box ./services/box\nCOPY services/creative/sql ./services/creative/sql\n",
      ),
    });
    const narrow = (changed: string[]): string[] => rebuilt(selectAffectedImages(changed, narrowed));
    expect(narrow(["services/console/app/accounts/page.tsx"])).toEqual(["console"]);
    expect(narrow(["docs/install.md"])).toEqual(WITH_DOCS);
    expect(narrow(["images/runtime-base/Dockerfile"])).toEqual(["runtime-base"]);
    expect(narrow(["README.md", ".github/workflows/tests.yml", "integrations/notion/integration.json"])).toEqual([]);
    expect(narrow(["services/creative/agent.json"])).toEqual(["creative-builder", "creative-runtime"]);
    expect(narrow(["services/creative/sql/001-eve-workflow.sql"])).toEqual(["creative-builder", "creative-runtime", "keeper"]);
    expect(narrow(["packages/agent-kit/src/public-docs.ts"])).toEqual(INSTALLING);
  });
});

describe("trees that exist only in memory", () => {
  const image = (id: string, extra: Partial<ImageSpec> = {}): ImageSpec => ({
    id,
    registry: `registry.example/${id}`,
    dockerfile: `images/${id}/Dockerfile`,
    context: ".",
    target: null,
    workflow: `.github/workflows/${id}.yml`,
    ...extra,
  });
  const manifests = {
    "package.json": JSON.stringify({ name: "root", pnpm: { patchedDependencies: { "thing@1.0.0": "fixes/thing.patch" } } }),
    "pnpm-workspace.yaml": "packages:\n  - services/*\n  - packages/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "fixes/thing.patch": "",
    "services/app/package.json": JSON.stringify({ name: "@x/app", dependencies: { "@x/lib": "workspace:*", left: "1.0.0" } }),
    "services/app/main.ts": "",
    "packages/lib/package.json": JSON.stringify({ name: "@x/lib", devDependencies: { "@x/deep": "workspace:^" } }),
    "packages/lib/index.ts": "",
    "packages/deep/package.json": JSON.stringify({ name: "@x/deep" }),
    "packages/deep/index.ts": "",
    "packages/alone/package.json": JSON.stringify({ name: "@x/alone" }),
    "packages/alone/index.ts": "",
  };

  it("rebuilds everything built FROM an image of this repository, however far down the chain", () => {
    const images = [image("base"), image("middle"), image("top"), image("other")];
    const tree = memoryRepo({
      ...manifests,
      "images/base/Dockerfile": "FROM debian:bookworm-slim\nCOPY images/base/setup.sh /setup.sh\n",
      "images/base/setup.sh": "",
      "images/middle/Dockerfile": "FROM registry.example/base:1.4@sha256:" + "a".repeat(64) + " AS run\nRUN true\n",
      "images/top/Dockerfile": "FROM debian:bookworm-slim\nCOPY --from=registry.example/middle:latest /opt /opt\n",
      "images/other/Dockerfile": "FROM registry.example/elsewhere/base:1\n",
    });
    const selection = selectAffectedImages(["images/base/setup.sh"], tree, images);
    expect(rebuilt(selection)).toEqual(["base", "middle", "top"]);
    expect(reasonFor(selection, "middle")).toMatch(/images\/middle\/Dockerfile is built FROM base, which is rebuilt \(images\/base\/setup\.sh is copied/);
    expect(reasonFor(selection, "top")).toMatch(/is built FROM middle, which is rebuilt/);
    expect(rebuilt(selectAffectedImages(["images/middle/Dockerfile"], tree, images))).toEqual(["middle", "top"]);
  });

  it("follows workspace links transitively, through every dependency section, and nowhere else", () => {
    const images = [image("app")];
    const tree = memoryRepo({
      ...manifests,
      "images/app/Dockerfile": [
        "FROM node:24 AS deps",
        "COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./",
        "RUN pnpm install --frozen-lockfile \\",
        "    # a comment inside a continued instruction",
        "    --filter @x/app...",
        "FROM node:24-slim",
        "COPY --from=deps /app /app",
        "",
      ].join("\n"),
    });
    for (const path of ["services/app/main.ts", "packages/lib/index.ts", "packages/deep/index.ts", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "fixes/thing.patch", "fixes/another.patch"]) {
      expect(rebuilt(selectAffectedImages([path], tree, images)), path).toEqual(["app"]);
    }
    expect(reasonFor(selectAffectedImages(["packages/deep/index.ts"], tree, images), "app")).toMatch(/is in @x\/deep, which @x\/app depends on \(@x\/app -> @x\/lib -> @x\/deep\)/);
    // A package nothing links to is not an input, but nothing else places it either: every image.
    const alone = selectAffectedImages(["packages/alone/index.ts"], tree, images);
    expect(alone.all).toBe(true);
    expect(alone.unknownPaths).toEqual(["packages/alone/index.ts"]);
  });

  it("counts every workspace package when an install names no filter, or a command runs in all of them", () => {
    const everything = ["@x/alone", "@x/app", "@x/deep", "@x/lib"];
    const packagesOf = (run: string): readonly string[] =>
      describeImages(memoryRepo({ ...manifests, "images/app/Dockerfile": `FROM node:24\nCOPY package.json ./\nRUN ${run}\n` }), [image("app")]).images[0]!.workspacePackages;
    expect(packagesOf("pnpm install --frozen-lockfile")).toEqual(everything);
    expect(packagesOf("pnpm install --filter @x/deep && pnpm -r build")).toEqual(everything);
    // One command's filter does not narrow another command's unfiltered install.
    expect(packagesOf("pnpm --filter @x/deep build && pnpm install")).toEqual(everything);
    expect(packagesOf("corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --filter @x/lib...")).toEqual(["@x/deep", "@x/lib"]);
    expect(packagesOf("corepack prepare pnpm@9.15.0 --activate && apt-get install -y git")).toEqual([]);
  });

  it("reads only the stages the build target reaches", () => {
    const images = [image("small", { dockerfile: "Dockerfile", target: "small" }), image("large", { dockerfile: "Dockerfile" })];
    const tree = memoryRepo({
      ...manifests,
      "one.txt": "",
      "two.txt": "",
      "three.txt": "",
      Dockerfile: "FROM scratch AS common\nCOPY one.txt /\nFROM common AS small\nCOPY two.txt /\nFROM scratch AS unused\nCOPY three.txt /\nFROM common\nCOPY --from=small /two.txt /\nCOPY three.txt /\n",
    });
    expect(rebuilt(selectAffectedImages(["one.txt"], tree, images))).toEqual(["large", "small"]);
    expect(rebuilt(selectAffectedImages(["two.txt"], tree, images))).toEqual(["large", "small"]);
    expect(rebuilt(selectAffectedImages(["three.txt"], tree, images))).toEqual(["large"]);
  });

  it("resolves COPY sources against the build context, and matches wildcards the way Docker does", () => {
    const images = [image("sub", { dockerfile: "images/sub/Dockerfile", context: "images/sub" }), image("glob", { dockerfile: "images/glob/Dockerfile" })];
    const tree = memoryRepo({
      ...manifests,
      "images/sub/Dockerfile": "FROM scratch\nCOPY --chmod=0555 ./files/ /files/\nCOPY [\"conf.d\", \"/etc/conf.d\"]\n",
      "images/sub/files/a": "",
      "images/sub/conf.d/b": "",
      "images/sub/.dockerignore": "",
      "images/glob/Dockerfile": "FROM scratch\nCOPY services/*/package.json /manifests/\n",
    });
    expect(rebuilt(selectAffectedImages(["images/sub/files/a"], tree, images))).toEqual(["sub"]);
    expect(rebuilt(selectAffectedImages(["images/sub/conf.d/b"], tree, images))).toEqual(["sub"]);
    expect(rebuilt(selectAffectedImages(["images/sub/.dockerignore"], tree, images))).toEqual(["sub"]);
    expect(rebuilt(selectAffectedImages([".dockerignore"], tree, images))).toEqual(["glob"]);
    expect(rebuilt(selectAffectedImages(["services/app/package.json"], tree, images))).toEqual(["glob"]);
    // `*` stops at a `/`: the wildcard copy does not carry the service's other files.
    expect(selectAffectedImages(["services/app/main.ts"], tree, images).unknownPaths).toEqual(["services/app/main.ts"]);
  });

  const unsureCases: { name: string; dockerfile?: string; files?: Record<string, string>; says: RegExp }[] = [
    { name: "a COPY whose source is a variable", dockerfile: "FROM scratch\nARG WHAT\nCOPY $WHAT /x\n", says: /uses a variable/ },
    { name: "a COPY here-document", dockerfile: "FROM scratch\nCOPY <<EOF /x\nhello\nEOF\n", says: /here-document/ },
    { name: "a COPY flag it does not know", dockerfile: "FROM scratch\nCOPY --parents a/b /x\n", says: /uses --parents/ },
    { name: "a COPY of something that is not in the repository", dockerfile: "FROM scratch\nCOPY build/output /x\n", says: /copies build\/output, which is neither in the repository nor a known generated path/ },
    { name: "a COPY that climbs out of the context", dockerfile: "FROM scratch\nCOPY ../secrets /x\n", says: /names a path this selector does not read/ },
    { name: "a RUN that mounts files into the build", dockerfile: "FROM scratch\nRUN --mount=type=cache,target=/c --mount=type=bind,source=.,target=/src make\n", says: /mounts files into the build/ },
    { name: "a RUN bind mount with no type", dockerfile: "FROM scratch\nRUN --mount=target=/src make\n", says: /mounts files into the build/ },
    { name: "a base image that is a variable", dockerfile: "ARG BASE=debian\nFROM $BASE\n", says: /does not name a fixed base image/ },
    { name: "an ONBUILD instruction", dockerfile: "FROM scratch\nONBUILD COPY . /x\n", says: /ONBUILD/ },
    { name: "a --filter that names no workspace package", dockerfile: "FROM node:24\nRUN pnpm install --filter @x/gone...\n", says: /--filter @x\/gone\.\.\. does not name a workspace package/ },
    { name: "a --filter that is a path", dockerfile: "FROM node:24\nRUN pnpm install --filter ./services/app\n", says: /does not name a workspace package/ },
    { name: "a --filter that asks for a package's dependents", dockerfile: "FROM node:24\nRUN pnpm install --filter ...@x/lib\n", says: /does not name a workspace package/ },
    { name: "a Dockerfile with its own escape character", dockerfile: "# escape=`\nFROM scratch\n", says: /sets its own escape character/ },
    { name: "a Dockerfile with no FROM", dockerfile: "# nothing here\n", says: /has no FROM/ },
    { name: "a missing Dockerfile", says: /images\/app\/Dockerfile is missing/ },
    { name: "a workspace file with a pattern it does not read", dockerfile: "FROM scratch\n", files: { "pnpm-workspace.yaml": "packages:\n  - 'services/**'\n" }, says: /a pattern this selector does not read/ },
    { name: "a workspace link to a package that is not there", dockerfile: "FROM scratch\n", files: { "services/app/package.json": JSON.stringify({ name: "@x/app", dependencies: { "@x/gone": "workspace:*" } }) }, says: /links to @x\/gone, which is not a workspace package/ },
    { name: "a package.json that is not JSON", dockerfile: "FROM scratch\n", files: { "packages/lib/package.json": "{" }, says: /packages\/lib\/package\.json is not valid JSON/ },
  ];

  it.each(unsureCases)("answers every image when it meets $name", ({ dockerfile, files, says }) => {
    const images = [image("app"), image("bystander")];
    const tree = memoryRepo({
      ...manifests,
      "images/bystander/Dockerfile": "FROM scratch\n",
      ...(dockerfile === undefined ? {} : { "images/app/Dockerfile": dockerfile }),
      ...files,
    });
    expect(() => selectAffectedImages(["services/app/main.ts"], tree, images)).toThrow(SelectorUnsure);
    const selection = selectAffectedImagesOrAll(["services/app/main.ts"], tree, images);
    expect(selection.all).toBe(true);
    expect(rebuilt(selection)).toEqual(["app", "bystander"]);
    expect(selection.allBecause).toMatch(/^the selector could not be sure, so every image is rebuilt: /);
    expect(selection.allBecause).toMatch(says);
    for (const decision of selection.images) expect(decision.reason).toBe(selection.allBecause);
  });

  it("allows a build cache mount, which reads nothing from the repository", () => {
    const tree = memoryRepo({ ...manifests, "images/app/Dockerfile": "FROM node:24\nCOPY package.json ./\nRUN --mount=type=cache,target=/pnpm/store pnpm install --filter @x/app...\n" });
    expect(rebuilt(selectAffectedImages(["packages/deep/index.ts"], tree, [image("app")]))).toEqual(["app"]);
  });

  it.each(["/etc/passwd", "../outside", "services/../../outside", "services\\console\\x"])("answers every image for %s, which is not a path inside the repository", (path) => {
    expect(() => selectAffectedImages([path], repo)).toThrow(SelectorUnsure);
    expect(rebuilt(selectAffectedImagesOrAll([path], repo))).toEqual(ALL);
  });

  it("needs nothing from the repository to say that nothing changed, or that everything must be rebuilt", () => {
    const nothing = memoryRepo({});
    expect(rebuilt(selectAffectedImages([], nothing))).toEqual([]);
    const everything = everyImage("the list of changes is not available");
    expect(rebuilt(everything)).toEqual(ALL);
    expect(everything.images.every((decision) => decision.reason === "the list of changes is not available")).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// Guards
// -------------------------------------------------------------------------------------------------

interface Workflow {
  on?: { push?: { paths?: string[] } };
  jobs?: Record<string, { strategy?: { matrix?: Record<string, unknown> }; steps?: { id?: string; uses?: string; run?: string; with?: Record<string, unknown> }[] }>;
}

const workflowFiles = tracked.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path));
const workflowText = (path: string): string => repo.readFile(path)!;
const workflow = (path: string): Workflow => parseYaml(workflowText(path)) as Workflow;
const imageWorkflows = [...new Set(IMAGES.map((image) => image.workflow))].sort();
const pathsFilter = (path: string): string[] => workflow(path).on?.push?.paths ?? [];

/** Every image a workflow builds AND pushes, read from its docker/build-push-action steps. */
function publishedBuilds(path: string): { registry: string; dockerfile: string; context: string; target: string | null }[] {
  const builds: { registry: string; dockerfile: string; context: string; target: string | null }[] = [];
  for (const job of Object.values(workflow(path).jobs ?? {})) {
    const matrix = Object.entries(job.strategy?.matrix ?? {}).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]));
    // One build per matrix value; a job with no matrix is one build.
    let combinations: Record<string, string>[] = [{}];
    for (const [key, values] of matrix) combinations = combinations.flatMap((combination) => values.map((value) => ({ ...combination, [key]: String(value) })));
    for (const combination of combinations) {
      const fill = (value: unknown): string => String(value ?? "").replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_whole, key: string) => combination[key] ?? "");
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("docker/build-push-action@")) continue;
        const settings = step.with ?? {};
        if (settings.push === undefined || settings.push === false || settings.push === "false") continue; // built to be tested, never pushed
        let tags = fill(settings.tags);
        const fromStep = /steps\.([\w-]+)\.outputs\.tags/.exec(tags);
        if (fromStep) tags = fill(job.steps!.find((other) => other.id === fromStep[1])?.with?.images);
        const name = tags.trim().split(/\s+/)[0]!;
        const context = fill(settings.context) || ".";
        builds.push({
          registry: name.replace(/:[^/:]*$/, "").toLowerCase(),
          dockerfile: settings.file === undefined ? `${context}/Dockerfile` : fill(settings.file),
          context,
          target: settings.target === undefined ? null : fill(settings.target),
        });
      }
    }
  }
  return builds;
}

describe("guards: the selector's tables against the repository", () => {
  it("knows every Dockerfile in the repository", () => {
    const dockerfiles = tracked.filter((path) => /(^|\/)(Dockerfile(\.[^/]+)?|[^/]+\.dockerfile)$/i.test(path) && !path.endsWith(".dockerignore")).sort();
    const known = [...new Set([...IMAGES.map((image) => image.dockerfile), ...DOCKERFILES_NO_WORKFLOW_BUILDS.map((entry) => entry.dockerfile)])].sort();
    // A new Dockerfile lands here. Add it to IMAGES (with the workflow that builds it), or to
    // DOCKERFILES_NO_WORKFLOW_BUILDS with the reason.
    expect(dockerfiles).toEqual(known);
    for (const entry of DOCKERFILES_NO_WORKFLOW_BUILDS) {
      expect(entry.why).not.toBe("");
      for (const path of workflowFiles) expect(workflowText(path), `${path} mentions ${entry.dockerfile}`).not.toContain(entry.dockerfile);
    }
  });

  it("knows every workflow, and which of them build images", () => {
    const known = [...imageWorkflows, ...WORKFLOWS_THAT_BUILD_NO_IMAGE.map((entry) => entry.workflow)].sort();
    // A new workflow lands here. If it builds an image, give that image a row in IMAGES;
    // otherwise name it in WORKFLOWS_THAT_BUILD_NO_IMAGE.
    expect([...workflowFiles].sort()).toEqual(known);
    for (const entry of WORKFLOWS_THAT_BUILD_NO_IMAGE) {
      expect(workflowText(entry.workflow), entry.workflow).not.toMatch(/docker\/build-push-action|docker\s+(buildx\s+)?build\b|docker\s+push\b/);
    }
  });

  it("lists exactly the images the workflows build and push, each with its Dockerfile, context and target", () => {
    const fromWorkflows = imageWorkflows
      .flatMap((path) => publishedBuilds(path).map((build) => ({ ...build, workflow: path })))
      .map((build) => `${build.registry} <- ${build.dockerfile} (context ${build.context}, target ${build.target}) in ${build.workflow}`);
    const fromTable = IMAGES.map((image) => `${image.registry} <- ${image.dockerfile} (context ${image.context}, target ${image.target}) in ${image.workflow}`);
    expect([...new Set(fromWorkflows)].sort()).toEqual([...fromTable].sort());
    expect(new Set(IMAGES.map((image) => image.id)).size).toBe(IMAGES.length);
    // Nothing is pushed by a hand-written command this test would not see.
    for (const path of workflowFiles) expect(workflowText(path), path).not.toMatch(/docker\s+push\b|--push\b|--output[= ]\S*type=registry/);
  });

  it("builds its model of the real repository without a single thing it is unsure about", () => {
    const model = describeImages(repo);
    expect(model.images.map((image) => image.id)).toEqual(IMAGES.map((image) => image.id));
    expect(selectAffectedImagesOrAll(["services/console/package.json"], repo).all).toBe(false);
    // The patch the root package.json names is an input of every image that installs, by name.
    const patches = Object.values((JSON.parse(repo.readFile("package.json")!) as { pnpm: { patchedDependencies: Record<string, string> } }).pnpm.patchedDependencies);
    expect(patches.length).toBeGreaterThan(0);
    for (const image of model.images.filter((entry) => INSTALLING.includes(entry.id))) {
      for (const patch of patches) expect(image.inputs.some((input) => input.kind === "install" && input.path === patch), `${image.id}: ${patch}`).toBe(true);
    }
    expect(model.images.filter((image) => image.inputs.some((input) => input.kind === "install")).map((image) => image.id).sort()).toEqual(INSTALLING);
  });

  describe("every entry in every image workflow's paths: filter is covered by a rule", () => {
    // Entries that match nothing in the repository. They cannot select anything, here or there.
    const DEAD_ENTRIES: Record<string, string> = {
      ".github/workflows/chief-of-staff-builder.yml services/network/**": "services/network does not exist",
    };
    // Exclusions the selector deliberately does NOT repeat: it would rather rebuild.
    const EXCLUSIONS_NOT_REPEATED: Record<string, string> = {
      ".github/workflows/sync-jobs-image.yml !services/box/compose.yaml":
        "the Dockerfile copies all of services/box, so a file at that path would be in the image; there is no such file today",
    };
    // Entries wider than the image: the workflow starts on them, but nothing they match is an
    // input of an image that workflow builds. The selector follows the Dockerfile here.
    const WIDER_THAN_THE_IMAGE: Record<string, string> = {
      ".github/workflows/chief-of-staff-builder.yml images/**":
        "the builder image is the Dockerfile's last stage, which copies nothing under images/; only the runtime stage does, and another workflow builds that",
      ".github/workflows/creative-builder.yml images/**":
        "the builder image is the Dockerfile's last stage, which copies nothing under images/; only the runtime stage does, and another workflow builds that",
    };
    /** Paths the Dockerfiles and the workspace decide: nothing in a filter needs a rule of its own there. */
    const BUILD_CONTEXT = ["services", "packages", "images", "patches", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json"];

    const entries = imageWorkflows.flatMap((path) => pathsFilter(path).map((entry) => ({ workflow: path, entry })));

    it("reads a paths: filter from every image workflow", () => {
      for (const path of imageWorkflows) expect(pathsFilter(path).length, path).toBeGreaterThan(0);
    });

    it.each(entries)("$workflow: $entry", ({ workflow: path, entry }) => {
      const images = IMAGES.filter((image) => image.workflow === path).map((image) => image.id);
      const model = describeImages(repo);
      if (entry.startsWith("!")) {
        expect(EXCLUSIONS_NOT_REPEATED[`${path} ${entry}`], "a new exclusion: decide whether the selector may repeat it").toBeDefined();
        const selection = selectAffectedImages([entry.slice(1)], repo);
        expect(rebuilt(selection)).toEqual(expect.arrayContaining(images));
        return;
      }
      // Only two shapes are in use: one file, or everything under one directory.
      expect(entry, "a filter shape this guard does not read yet").toMatch(/^[A-Za-z0-9._/-]+(\/\*\*)?$/);
      const base = entry.replace(/\/\*\*$/, "");
      const matches = tracked.filter((file) => (entry.endsWith("/**") ? file.startsWith(`${base}/`) : file === base));

      // A path a workflow names as an input must never be one the selector calls "in no image".
      for (const rule of IN_NO_IMAGE) expect(under(rule.path, base) || under(base, rule.path), `${entry} overlaps the in-no-image rule ${rule.path}`).toBe(false);

      if (matches.length === 0) {
        expect(DEAD_ENTRIES[`${path} ${entry}`], "an entry that matches no file: is the selector missing an input?").toBeDefined();
        return;
      }

      const declared = WORKFLOW_DECLARED_INPUTS.find((rule) => rule.path === base);
      const generated = GENERATED_CONTEXT_PATHS.find((rule) => rule.from.includes(base));
      if (base === path) {
        // The workflow's own file.
        for (const id of images) expect(model.images.find((image) => image.id === id)!.inputs).toContainEqual(expect.objectContaining({ kind: "workflow", path }));
      } else if (declared) {
        expect(declared.workflows, `${entry} is a declared input, but not of ${path}`).toContain(path);
      } else if (generated) {
        // At least one image this workflow builds copies what is generated from this path.
        const carrying = model.images.filter((image) => image.workflow === path && image.inputs.some((input) => input.kind === "generated" && input.path === base));
        expect(carrying.length, `${path} names ${entry}, but none of its images copies ${generated.path}`).toBeGreaterThan(0);
      } else {
        // Anything else must be a path the Dockerfiles and the workspace decide. A filter that
        // names a path outside the build context is naming an input this selector has no rule for:
        // add it to WORKFLOW_DECLARED_INPUTS or GENERATED_CONTEXT_PATHS.
        expect(BUILD_CONTEXT.some((root) => under(base, root)), `${path} names ${entry}, which no rule of the selector covers`).toBe(true);
      }

      // And the rule has an effect: some file the entry matches rebuilds an image of this workflow,
      // unless the entry is known to be wider than the image, and then none does.
      const selection = selectAffectedImages(matches, repo);
      expect(selection.unknownPaths).toEqual([]);
      const wider = WIDER_THAN_THE_IMAGE[`${path} ${entry}`] !== undefined;
      expect(rebuilt(selection).some((id) => images.includes(id)), `${entry} and the images ${images.join(", ")}`).toBe(!wider);
    });

    it("declares an out-of-context input for exactly the workflows whose filter names it", () => {
      for (const rule of WORKFLOW_DECLARED_INPUTS) {
        const naming = imageWorkflows.filter((path) => pathsFilter(path).some((entry) => entry.replace(/\/\*\*$/, "") === rule.path));
        expect([...rule.workflows].sort(), rule.path).toEqual(naming);
        expect(tracked.some((file) => under(file, rule.path)), `${rule.path} is not in the repository`).toBe(true);
      }
    });
  });

  it("traces every generated build input back to what it is generated from", () => {
    const model = describeImages(repo);
    for (const generated of GENERATED_CONTEXT_PATHS) {
      // Generated means generated: the path is not in the repository, and git ignores nothing of it by accident.
      expect(tracked.some((file) => under(file, generated.path)), `${generated.path} is committed`).toBe(false);
      for (const from of generated.from) expect(tracked.some((file) => under(file, from)), `${from} is not in the repository`).toBe(true);
      const carrying = model.images.filter((image) => image.inputs.some((input) => input.kind === "generated"));
      expect(carrying.map((image) => image.id).sort()).toEqual(WITH_DOCS);
      for (const image of carrying) {
        // The workflow really does write it before the build, from the script the rule names...
        expect(workflowText(image.workflow), image.workflow).toContain(generated.path);
        expect(workflowText(image.workflow), image.workflow).toContain("scripts/public-docs.ts export");
        // ...and names both sources in its own filter.
        for (const from of generated.from) expect(pathsFilter(image.workflow).map((entry) => entry.replace(/\/\*\*$/, "")), `${image.workflow}: ${from}`).toContain(from);
        // The exporter imports agent-kit, which must already be an input of the same image.
        expect(repo.readFile("scripts/public-docs.ts")).toContain("../packages/agent-kit/src/public-docs.js");
        expect(image.workspacePackages).toContain("@lares/agent-kit");
      }
    }
  });

  it("finds every workspace package in at least one image", () => {
    const model = describeImages(repo);
    // A package that is in no image is named here with the reason. There is none today: keeper
    // copies packages/ and services/ whole. The second list is the packages that are in an image
    // ONLY because of that whole-directory copy: nothing an image installs links to them.
    const IN_NO_IMAGE_PACKAGES: Record<string, string> = {};
    const ONLY_BY_DIRECTORY_COPY = ["@lares/board-evals", "@lares/memory-evals", "@lares/readability"];

    const manifests = tracked.filter((path) => /^(services|packages)\/[^/]+\/package\.json$/.test(path));
    expect(model.workspace.map((pkg) => `${pkg.dir}/package.json`).sort()).toEqual([...manifests].sort());

    const unreachable: string[] = [];
    const onlyCopied: string[] = [];
    for (const pkg of model.workspace) {
      const manifest = `${pkg.dir}/package.json`;
      const selection = selectAffectedImages([manifest], repo);
      expect(selection.unknownPaths, manifest).toEqual([]);
      const linked = model.images.some((image) => image.workspacePackages.includes(pkg.name));
      const specific = model.images.some((image) => image.inputs.some((input) => input.kind !== "whole-context" && under(manifest, input.path)));
      if (!specific) unreachable.push(pkg.name);
      else if (!linked) onlyCopied.push(pkg.name);
    }
    expect(unreachable.sort()).toEqual(Object.keys(IN_NO_IMAGE_PACKAGES).sort());
    expect(onlyCopied.sort()).toEqual(ONLY_BY_DIRECTORY_COPY);
  });

  it("can still prove every 'in no image' rule", () => {
    const model = describeImages(repo);
    const filters = imageWorkflows.flatMap((path) => pathsFilter(path).filter((entry) => !entry.startsWith("!")).map((entry) => entry.replace(/\/\*\*$/, "")));
    for (const rule of IN_NO_IMAGE) {
      expect(rule.why).not.toBe("");
      const files = tracked.filter((file) => under(file, rule.path));
      // A rule about a path that is gone is a rule nobody is checking.
      expect(files.length, `${rule.path} is not in the repository`).toBeGreaterThan(0);
      // No workspace package contains it, and no image workflow names it.
      for (const pkg of model.workspace) expect(under(rule.path, pkg.dir) || under(pkg.dir, rule.path), `${rule.path} and ${pkg.dir}`).toBe(false);
      for (const entry of filters) expect(under(rule.path, entry) || under(entry, rule.path), `${rule.path} and the filter entry ${entry}`).toBe(false);
      // No Dockerfile names it: the only inputs that reach it are copies of the whole context.
      const selection = selectAffectedImages(files, repo);
      expect(selection.unknownPaths).toEqual([]);
      for (const image of selection.images.filter((decision) => decision.rebuild)) {
        for (const reason of image.reasons) expect(reason, `${image.image}: ${rule.path}`).toMatch(/is inside the build context that \S+ copies whole/);
      }
    }
    // A workflow that builds no image is covered the same way.
    for (const entry of WORKFLOWS_THAT_BUILD_NO_IMAGE) {
      for (const image of selectAffectedImages([entry.workflow], repo).images.filter((decision) => decision.rebuild)) {
        expect(image.reason).toMatch(/copies whole/);
      }
    }
  });
});

describe("the command-line entry", () => {
  const bin = join(REPO, "services", "box", "bin", "affected-images.ts");
  const run = (args: string[], input = ""): { status: number; out: string } => {
    try {
      // Plain `node`, as a workflow would run it before anything is installed.
      return { status: 0, out: execFileSync(process.execPath, [bin, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }) };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      return { status: failure.status ?? -1, out: failure.stdout ?? "" };
    }
  };

  it("prints the same answer as the library for paths on standard input", () => {
    const { status, out } = run(["--stdin"], "services/console/package.json\n\ndocs/install.md\n");
    expect(status).toBe(0);
    expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(selectAffectedImages(["services/console/package.json", "docs/install.md"], repo))));
  });

  it("compares two commits, reading the manifests from the newer one", () => {
    const { status, out } = run(["--base", "HEAD", "--head", "HEAD"]);
    expect(status).toBe(0);
    const selection = JSON.parse(out) as Selection;
    expect(selection.changed).toEqual([]);
    expect(rebuilt(selection)).toEqual([]);
  });

  it("answers every image, and still exits 0, when git cannot say what changed", () => {
    const { status, out } = run(["--base", "no-such-commit", "--head", "HEAD"]);
    expect(status).toBe(0);
    const selection = JSON.parse(out) as Selection;
    expect(selection.all).toBe(true);
    expect(rebuilt(selection)).toEqual(ALL);
    expect(selection.allBecause).toMatch(/git could not list what changed between no-such-commit and HEAD/);
  });

  it("prints every image with its inputs", () => {
    const { status, out } = run(["--describe"]);
    expect(status).toBe(0);
    expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(describeImages(repo))));
  });

  it.each([[["--bogus"]], [[]], [["--base", "HEAD"]], [["--stdin", "--describe"]], [["--base", "HEAD", "--head"]]])("refuses a wrong command line %j with exit 2 and no answer", (args) => {
    const { status, out } = run(args);
    expect(status).toBe(2);
    expect(out).toBe("");
  });
});
