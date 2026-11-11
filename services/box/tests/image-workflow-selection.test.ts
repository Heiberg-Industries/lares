// image-workflow-selection.test.ts — how the workflow "keeper and neutral runtime images" uses
// the answer of bin/images-to-build.ts, read from the workflow file itself.
//
// Three things are held here:
//   1. the wiring: a `select` job runs first, and every other job, each role and each push is
//      left out ONLY when its flag says exactly 'false';
//   2. the fail-closed rule: the `select` step's own script is RUN here (bash, as the runner
//      runs it) and must answer "every image" for a publishing run and for every way the
//      selection can fail, with every output set each time;
//   3. that nothing else moved: the triggers, the `paths:` filter, the permissions, the runners,
//      the actions, and the list of steps of the three jobs that build and prove the images.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FLAGS } from "../bin/images-to-build.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW_TEXT = readFileSync(join(REPO, ".github", "workflows", "keeper-runtime-images.yml"), "utf8");
const workflow = parse(WORKFLOW_TEXT);

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
}
const steps = (job: string): Step[] => workflow.jobs[job].steps as Step[];

/** When a run publishes. The same words gate every push, and tell the `select` step to build everything. */
const PUBLISHES = "(github.event_name == 'workflow_dispatch' && inputs.publish) || (github.event_name != 'workflow_dispatch' && vars.PUBLISH_IMAGES == 'true')";
const OUTPUT_NAMES = ["all", ...FLAGS.map(({ flag }) => flag), "anyKeeperFamily"];
const EVERY_OUTPUT_TRUE = OUTPUT_NAMES.map((name) => `${name}=true\n`).join("");
const BUILDING_JOBS = ["real-install", "runtime", "keeper"];

describe("the image workflow asks which images a change affects before it builds", () => {
  const select = workflow.jobs.select;
  const selectStep = steps("select").find((step) => step.id === "select")!;

  it("runs the select job first, and every other job waits for it", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["select", ...BUILDING_JOBS]);
    expect(select.needs).toBeUndefined();
    for (const job of BUILDING_JOBS) expect(workflow.jobs[job].needs, job).toBe("select");
  });

  it("runs the select job whenever the other jobs could run", () => {
    expect(select.if).toBe("${{ vars.BUILD_IMAGES == 'true' || github.event_name == 'workflow_dispatch' }}");
    expect(select["runs-on"]).toBe("ubuntu-24.04");
  });

  it("checks out the whole history and sets up Node 24, and installs nothing", () => {
    const [checkout, node, last, ...more] = steps("select");
    expect(more).toEqual([]);
    expect(last).toBe(selectStep);
    expect(checkout!.uses).toBe("actions/checkout@v4");
    expect(checkout!.with).toEqual({ "fetch-depth": 0 });
    expect(node!.uses).toBe("actions/setup-node@v4");
    expect(node!.with).toEqual({ "node-version": "24" });
    expect(JSON.stringify(select)).not.toMatch(/pnpm|npm install|corepack/);
    expect(selectStep.run).toContain('node services/box/bin/images-to-build.ts --base "${BASE-}" --head "$GITHUB_SHA" --outputs "$outputs" --summary "$summary"');
  });

  it("lets neither setup step stop the job: the select step then answers every image by itself", () => {
    const [checkout, node] = steps("select");
    expect(checkout!["continue-on-error"]).toBe(true);
    expect(node!["continue-on-error"]).toBe(true);
    // The select step itself must not be allowed to fail quietly, and must always run.
    expect(selectStep["continue-on-error"]).toBeUndefined();
    expect(selectStep.if).toBeUndefined();
  });

  it("compares with the commit before a push, or with the base a manual run names", () => {
    expect(selectStep.env!.BASE).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.base || github.event_name == 'push' && github.event.before || '' }}");
    const input = workflow.on.workflow_dispatch.inputs.base;
    expect(input.type).toBe("string");
    expect(input.default).toBe("");
    expect(input.required).toBeUndefined();
    expect(input.description).toMatch(/Empty builds every image/);
    // The base reaches the script as an argument read from the environment, never as script text.
    expect(selectStep.run).not.toContain("${{");
  });

  it("exposes every flag as a job output, straight from the select step", () => {
    expect(select.outputs).toEqual(Object.fromEntries(OUTPUT_NAMES.map((name) => [name, `\${{ steps.select.outputs.${name} }}`])));
  });

  it("writes the table to the run summary and the flags to the outputs", () => {
    expect(selectStep.run).toContain('cat "$outputs" >> "$GITHUB_OUTPUT"');
    expect(selectStep.run).toContain('cat "$summary"; } >> "$GITHUB_STEP_SUMMARY"');
    expect(selectStep.run).toContain('echo "| image | decision | reason |"');
  });

  it("makes each job wait for its own flags, with its earlier conditions kept as they were", () => {
    const any = (flags: string[]): string => flags.map((flag) => `needs.select.outputs.${flag} != 'false'`).join(" || ");
    expect(workflow.jobs["real-install"].if).toBe(
      `\${{ (vars.BUILD_IMAGES == 'true' || github.event_name == 'workflow_dispatch') && (${any(FLAGS.map(({ flag }) => flag))}) }}`,
    );
    expect(workflow.jobs.runtime.if).toBe(
      `\${{ (vars.BUILD_IMAGES == 'true' || github.event_name == 'workflow_dispatch') && !inputs.real_install_only && (${any(["chiefRuntime", "creativeRuntime"])}) }}`,
    );
    expect(workflow.jobs.keeper.if).toBe(
      `\${{ (vars.BUILD_IMAGES == 'true' || github.event_name == 'workflow_dispatch') && !inputs.real_install_only && ${any(["anyKeeperFamily"])} }}`,
    );
  });

  it("leaves a role out of the runtime job only when its flag says exactly 'false'", () => {
    const matrix = workflow.jobs.runtime.strategy.matrix;
    expect(workflow.jobs.runtime.strategy["max-parallel"]).toBe(1);
    expect(Object.keys(matrix)).toEqual(["role", "exclude"]);
    expect(matrix.role).toEqual(["chief-of-staff", "creative"]);
    expect(matrix.exclude).toEqual([
      { role: "${{ needs.select.outputs.chiefRuntime == 'false' && 'chief-of-staff' || 'no role is left out' }}" },
      { role: "${{ needs.select.outputs.creativeRuntime == 'false' && 'creative' || 'no role is left out' }}" },
    ]);
    // The value an entry takes when its role is built must name no role, or it would remove one.
    expect(matrix.role).not.toContain("no role is left out");
    // Each role of the matrix has its own flag: a role added without one fails here.
    expect(matrix.exclude).toHaveLength(matrix.role.length);
  });

  it("pushes an image only on a publishing run and only when that image's flag is not 'false'", () => {
    const pushes = (job: string): Step[] => steps(job).filter((step) => step.uses?.startsWith("docker/build-push-action@") && step.with?.push !== undefined);
    const runtime = pushes("runtime");
    expect(runtime).toHaveLength(1);
    expect(runtime[0]!.with!.tags).toBe("ghcr.io/heiberg-industries/lares-engine-${{ matrix.role }}-runtime:sha-${{ github.sha }}");
    expect(runtime[0]!.with!.push).toBe(
      `\${{ (${PUBLISHES}) && !(matrix.role == 'chief-of-staff' && needs.select.outputs.chiefRuntime == 'false') && !(matrix.role == 'creative' && needs.select.outputs.creativeRuntime == 'false') }}`,
    );

    const keeper = pushes("keeper");
    expect(keeper.map((step) => step.with!.tags)).toEqual(["keeper", "firewall-helper", "egress-proxy"].map((image) => `ghcr.io/heiberg-industries/lares-engine-${image}:sha-\${{ github.sha }}`));
    for (const step of keeper) {
      const image = /lares-engine-([a-z-]+):/.exec(String(step.with!.tags))![1]!;
      const { flag } = FLAGS.find((entry) => entry.image === image)!;
      expect(step.with!.push, image).toBe(`\${{ (${PUBLISHES}) && needs.select.outputs.${flag} != 'false' }}`);
    }

    // Every image this workflow pushes is one of the five flags, and each flag gates a push.
    const gated = [...runtime, ...keeper].flatMap((step) => [...String(step.with!.push).matchAll(/needs\.select\.outputs\.(\w+)/g)].map((match) => match[1]!));
    expect(gated.sort()).toEqual(FLAGS.map(({ flag }) => flag).sort());
    // The real install job pushes nothing.
    expect(pushes("real-install")).toEqual([]);
  });
});

describe("doubt never skips a build", () => {
  const selectStep = steps("select").find((step) => step.id === "select")!;
  const script = selectStep.run!;

  it("skips on an explicit 'false' only: no flag is ever compared with 'true', defaulted, or used bare", () => {
    const uses = [...WORKFLOW_TEXT.matchAll(/needs\.select\.outputs\.\w+(.{0,12})/g)].map((match) => match[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(13);
    for (const after of uses) expect(after).toMatch(/^ (!=|==) 'false'/);
    expect(WORKFLOW_TEXT).not.toMatch(/outputs\.\w+\s*(==|!=)\s*'true'/);
    // An output that never arrived is empty, and empty is not 'false': everything is built.
    expect(WORKFLOW_TEXT).not.toMatch(/steps\.select\.outputs\.\w+\s*(\|\||&&)/);
  });

  it("never writes a false of its own: a false can only come from the script's complete answer", () => {
    // `complete=false` is the step's own note that the answer is not whole; it leads to "every image".
    const withoutThatNote = script.replaceAll("complete=false", "");
    expect(withoutThatNote).not.toMatch(/[\w$}"]\s*=\s*false\b/);
    expect(script).not.toMatch(/echo[^\n]*false/);
    // The one place a false is accepted: a line the script wrote, checked to be whole.
    expect(script).toContain('grep -cxE "$flag=(true|false)" "$outputs"');
    expect(script).toContain('echo "all=true"; for flag in $flags; do echo "$flag=true"; done;');
  });

  it("is told whether the run publishes by the same words that gate every push", () => {
    expect(selectStep.env!.PUBLISHING).toBe(`\${{ ${PUBLISHES} }}`);
    expect(script).toContain('if [ "${PUBLISHING-}" = "true" ]; then\n  build_everything "publishing run: every image is built, probed and pushed, whatever changed"');
    // Anything but a plain "false" is not taken as "this run does not publish".
    expect(script).toContain('elif [ "${PUBLISHING-}" != "false" ]; then\n  build_everything');
    // The script is asked only after both.
    expect(script.indexOf("node services/box/bin/images-to-build.ts")).toBeGreaterThan(script.indexOf('elif [ "${PUBLISHING-}" != "false" ]'));
  });

  // From here on the step's script is run, the way the runner runs a `run:` step with no `shell:`.
  const scratch = mkdtempSync(join(tmpdir(), "image-workflow-selection-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let runs = 0;

  /** A directory that stands in for the checkout, holding only a program at the script's path. */
  function checkoutWith(program: string | null): string {
    const dir = join(scratch, `checkout-${(runs += 1)}`);
    mkdirSync(join(dir, "services", "box", "bin"), { recursive: true });
    if (program !== null) writeFileSync(join(dir, "services", "box", "bin", "images-to-build.ts"), program);
    return dir;
  }

  /** A stand-in for the script: it finds the two files it was asked to write, then does what `body` says. */
  const standIn = (body: string): string =>
    [
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const outputs = args[args.indexOf("--outputs") + 1];',
      'const summary = args[args.indexOf("--summary") + 1];',
      'const table = () => fs.writeFileSync(summary, "| image | decision | reason |\\n");',
      body,
    ].join("\n");
  const KEEP_EVERYTHING = OUTPUT_NAMES.map((name) => `${name}=false\n`).join("");

  function runStep(options: { cwd: string; publishing?: string; base?: string; sha?: string }): { status: number | null; outputs: string; summary: string; log: string } {
    const dir = join(scratch, `run-${(runs += 1)}`);
    mkdirSync(join(dir, "temp"), { recursive: true });
    writeFileSync(join(dir, "step.sh"), script);
    const env: Record<string, string> = {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? dir,
      RUNNER_TEMP: join(dir, "temp"),
      GITHUB_OUTPUT: join(dir, "github-output"),
      GITHUB_STEP_SUMMARY: join(dir, "github-summary"),
      GITHUB_SHA: options.sha ?? "0123456789012345678901234567890123456789",
    };
    if (options.publishing !== undefined) env.PUBLISHING = options.publishing;
    if (options.base !== undefined) env.BASE = options.base;
    writeFileSync(env.GITHUB_OUTPUT!, "");
    writeFileSync(env.GITHUB_STEP_SUMMARY!, "");
    const result = spawnSync("bash", ["-e", join(dir, "step.sh")], { cwd: options.cwd, env, encoding: "utf8" });
    return { status: result.status, outputs: readFileSync(env.GITHUB_OUTPUT!, "utf8"), summary: readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8"), log: `${result.stdout}${result.stderr}` };
  }

  /** The step ended well and every output is set to true: nothing can be skipped. */
  function expectEverything(result: ReturnType<typeof runStep>, because: RegExp): void {
    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toBe(EVERY_OUTPUT_TRUE);
    expect(result.summary).toMatch(because);
    expect(result.summary.match(/^\| (chief-of-staff-runtime|creative-runtime|keeper|firewall-helper|egress-proxy) \| rebuild \| /gm)).toHaveLength(5);
    expect(result.summary).not.toContain("| keep |");
  }

  it("passes on a complete answer of the script exactly as it is, so the cases below prove something", () => {
    const answer = "all=false\nchiefRuntime=true\ncreativeRuntime=false\nkeeper=false\nfirewallHelper=false\negressProxy=true\nanyKeeperFamily=true\n";
    const result = runStep({ cwd: checkoutWith(standIn(`fs.writeFileSync(outputs, ${JSON.stringify(answer)}); fs.writeFileSync(summary, "| image | decision | reason |\\n| creative-runtime | keep | nothing of it changed |\\n");`)), publishing: "false", base: "abc" });
    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toBe(answer);
    expect(result.summary).toBe("### Images this run builds\n\n| image | decision | reason |\n| creative-runtime | keep | nothing of it changed |\n");
  });

  it("builds everything on a publishing run, whatever the script would have said", () => {
    const keepsEverything = standIn(`fs.writeFileSync(outputs, ${JSON.stringify(KEEP_EVERYTHING)}); table();`);
    expectEverything(runStep({ cwd: checkoutWith(keepsEverything), publishing: "true", base: "abc" }), /Every image is built and probed: publishing run: every image is built, probed and pushed, whatever changed/);
    // And it does not need the script, or a base, for that.
    expectEverything(runStep({ cwd: checkoutWith(null), publishing: "true" }), /publishing run/);
  });

  it.each([["missing", undefined], ["empty", ""], ["something else", "yes"], ["True", "True"]])("builds everything when it is not known whether the run publishes (%s)", (_name, publishing) => {
    const keepsEverything = standIn(`fs.writeFileSync(outputs, ${JSON.stringify(KEEP_EVERYTHING)}); table();`);
    expectEverything(runStep({ cwd: checkoutWith(keepsEverything), publishing, base: "abc" }), /it is not known whether this run publishes, so nothing is skipped/);
  });

  it.each<[string, string | null, RegExp]>([
    ["is not there (no checkout)", null, /exit status 1\)/],
    ["crashes before it answers", standIn('throw new Error("broken");'), /exit status 1\)/],
    ["refuses its command line", standIn("process.exit(2);"), /exit status 2\)/],
    ["writes a complete answer that keeps everything, and then fails", standIn(`fs.writeFileSync(outputs, ${JSON.stringify(KEEP_EVERYTHING)}); table(); process.exit(1);`), /exit status 1\)/],
    ["ends well and writes nothing", standIn(""), /exit status 0\)/],
    ["ends well and writes an empty answer", standIn('fs.writeFileSync(outputs, ""); table();'), /exit status 0\)/],
    ["leaves one flag out", standIn(`fs.writeFileSync(outputs, ${JSON.stringify(KEEP_EVERYTHING.replace("keeper=false\n", ""))}); table();`), /exit status 0\)/],
    ["leaves `all` out", standIn(`fs.writeFileSync(outputs, ${JSON.stringify(KEEP_EVERYTHING.replace("all=false\n", ""))}); table();`), /exit status 0\)/],
    ["gives a flag a value that is neither true nor false", standIn(`fs.writeFileSync(outputs, ${JSON.stringify(KEEP_EVERYTHING.replace("keeper=false", "keeper=no"))}); table();`), /exit status 0\)/],
    ["gives a flag no value", standIn(`fs.writeFileSync(outputs, ${JSON.stringify(KEEP_EVERYTHING.replace("keeper=false", "keeper="))}); table();`), /exit status 0\)/],
    ["names a flag twice", standIn(`fs.writeFileSync(outputs, ${JSON.stringify(`${KEEP_EVERYTHING}keeper=true\n`)}); table();`), /exit status 0\)/],
    ["adds a line that is not a flag", standIn(`fs.writeFileSync(outputs, ${JSON.stringify(`${KEEP_EVERYTHING}another=false\n`)}); table();`), /exit status 0\)/],
    ["writes the flags but no table", standIn(`fs.writeFileSync(outputs, ${JSON.stringify(KEEP_EVERYTHING)});`), /exit status 0\)/],
  ])("builds everything when the script %s", (_name, program, because) => {
    const result = runStep({ cwd: checkoutWith(program), publishing: "false", base: "abc" });
    expectEverything(result, /the selection script failed or left no complete answer/);
    expect(result.summary).toMatch(because);
  });

  describe("with the real script, in this repository", { timeout: 60_000 }, () => {
    const head = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    it.each([
      ["no base (a manual run that names none)", "", /no base commit was given/],
      ["no BASE at all", undefined, /no base commit was given/],
      ["a base of all zeros (the first push of a branch)", "0".repeat(40), /the base commit is all zeros \(a new branch\)/],
      ["a base git does not know", "no-such-commit", /git could not list what changed between no-such-commit and /],
      ["the head itself as the base", head, /the list of changed files is empty/],
    ])("builds everything for %s", (_name, base, because) => {
      expectEverything(runStep({ cwd: REPO, publishing: "false", base, sha: head }), because);
    });

    it("builds everything when the head is not a commit of this repository", () => {
      expectEverything(runStep({ cwd: REPO, publishing: "false", base: head }), /git could not list what changed/);
    });
  });
});

describe("nothing else about the image workflow moved", () => {
  it("starts on the same events, branches and paths", () => {
    expect(Object.keys(workflow.on)).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({
      branches: ["main"],
      paths: [
        "services/**",
        "packages/**",
        "images/**",
        "patches/**",
        "docs/**",
        "releases/**",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "package.json",
        "scripts/scan-image.sh",
        "scripts/public-docs.ts",
        ".github/workflows/keeper-runtime-images.yml",
      ],
    });
  });

  it("keeps the three manual inputs it had, and adds only `base`", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual(["publish", "docs_release", "real_install_only", "base"]);
    expect(inputs.publish).toEqual({ description: "Publish this exact manually selected ref", type: "boolean", default: false });
    expect(inputs.docs_release).toEqual({ description: "Public docs identity (candidate, or the exact release ID whose source is this ref)", type: "string", default: "candidate" });
    expect(inputs.real_install_only).toEqual({ description: "Run only the real install proof, to work on it without the other jobs", type: "boolean", default: false });
  });

  it("keeps its permissions, its environment, its runner and its actions", () => {
    expect(workflow.name).toBe("keeper and neutral runtime images");
    expect(workflow.permissions).toEqual({ contents: "read", packages: "write" });
    expect(workflow.env).toEqual({ EVE_TELEMETRY_DISABLED: "1" });
    expect(workflow.concurrency).toBeUndefined();
    for (const [id, job] of Object.entries<any>(workflow.jobs)) expect(job["runs-on"], id).toBe("ubuntu-24.04");
    const actions = new Set(Object.values<any>(workflow.jobs).flatMap((job) => (job.steps as Step[]).map((step) => step.uses).filter((uses) => uses !== undefined)));
    expect([...actions].sort()).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "actions/upload-artifact@v4",
      "docker/build-push-action@v6",
      "docker/login-action@v3",
      "docker/setup-buildx-action@v3",
    ]);
  });

  /** A step by its name; one without a name by its action and what it builds or uploads. Then its own condition, if it has one. */
  const label = (step: Step): string => {
    const what = step.name ?? [step.uses, step.with?.name ?? step.with?.tags ?? ""].filter((part) => part !== "").join(" ");
    return step.if === undefined ? what : `${what} [if: ${step.if}]`;
  };

  // The steps of the three jobs as they were before the select job existed: every build, every
  // proof, every upload, in order, each with the condition it had. Selection decides whether a
  // job runs. It must never decide what a job that runs checks. A step added, removed, renamed,
  // reordered or given a different condition fails here, and is then a decision of its own.
  const STEPS: Record<string, string[]> = {
    "real-install": [
      "actions/checkout@v4",
      "Enable corepack and prepare pnpm 9.15.0",
      "Setup Node 24 + pnpm",
      "Install the docs exporter",
      "Export and stage the verified public docs corpus",
      "Install the browser that plays the owner",
      "docker/setup-buildx-action@v3",
      "docker/build-push-action@v6 lares-keeper:test",
      "docker/build-push-action@v6 lares-squid:test",
      "docker/build-push-action@v6 lares-nft:test",
      "docker/build-push-action@v6 lares-console:test",
      "docker/build-push-action@v6 lares-chief:test",
      "docker/build-push-action@v6 lares-creative:test",
      "Install the real path on this server and use it",
      "actions/upload-artifact@v4 real-install-proof [if: always()]",
    ],
    runtime: [
      "actions/checkout@v4",
      "Enable corepack and prepare pnpm 9.15.0",
      "Setup Node 24 + pnpm",
      "Install the exporter and role dependency closures",
      "Check first-use config and Docker commands offline [if: matrix.role == 'chief-of-staff']",
      "Export and stage the verified public docs corpus",
      "docker/setup-buildx-action@v3",
      "Prove protected gateway authority staging and resolved Compose mount isolation [if: matrix.role == 'chief-of-staff']",
      "docker/login-action@v3",
      "docker/build-push-action@v6 lares-runtime:test",
      "Scan final runtime image",
      "actions/upload-artifact@v4 runtime-${{ matrix.role }}-image-scan [if: always()]",
      "Verify compiled executable and unprivileged runtime",
      "Exercise the pinned Eve production handoff cases",
      "Prove generated role startup admission in the actual Linux image",
      "actions/upload-artifact@v4 role-start-admission-${{ matrix.role }}-proof [if: always()]",
      "Verify the baked public docs corpus in the final role image",
      "actions/upload-artifact@v4 public-docs-${{ matrix.role }}-image-proof [if: always()]",
      "Exercise compiled runtime, mounted persona and gateway selection across restart [if: matrix.role == 'chief-of-staff']",
      "Prove guarded gateway ingress and physical dispatch in pinned upstream image [if: matrix.role == 'chief-of-staff']",
      "actions/upload-artifact@v4 gateway-admission-compatibility-proof [if: always() && matrix.role == 'chief-of-staff']",
      "Build the matching Keeper image for the combined first-use proof [if: matrix.role == 'chief-of-staff']",
      "Prove first native activation through compiled Eve and production Keeper [if: matrix.role == 'chief-of-staff']",
      "actions/upload-artifact@v4 native-first-use-proof [if: always() && matrix.role == 'chief-of-staff']",
      "Extract the compiled agent manifest [if: matrix.role != 'chief-of-staff']",
      "Enable corepack and prepare pnpm 9.15.0 [if: matrix.role != 'chief-of-staff']",
      "Setup Node 24 + pnpm [if: matrix.role != 'chief-of-staff']",
      "Install the role's own dependency closure [if: matrix.role != 'chief-of-staff']",
      "Run the agent-declaration conformance suite against the compiled manifest [if: matrix.role != 'chief-of-staff']",
      "Prove studio run ownership in the final creative image [if: matrix.role == 'creative']",
      "docker/build-push-action@v6 ghcr.io/heiberg-industries/lares-engine-${{ matrix.role }}-runtime:sha-${{ github.sha }}",
    ],
    keeper: [
      "actions/checkout@v4",
      "Prepare disposable hosted Docker image store",
      "docker/setup-buildx-action@v3",
      "docker/login-action@v3",
      "docker/build-push-action@v6 lares-keeper:test",
      "docker/build-push-action@v6 lares-squid:test",
      "docker/build-push-action@v6 lares-nft:test",
      "Check bounded import preview proof logic offline",
      "Prove packaged import preview reports only bounded member evidence",
      "actions/upload-artifact@v4 keeper-import-preview-proof [if: always()]",
      "Scan final keeper image",
      "Scan final network helper images",
      "Check bounded outside proof cleanup and safe failure evidence",
      "Prove configured outside discovery through the final Keeper and network helper images",
      "actions/upload-artifact@v4 keeper-outside-discovery-proof [if: always()]",
      "Prove fixed database roles in the final Keeper image [if: always() && !cancelled() && steps.keeper-image.outcome == 'success']",
      "Verify keeper runtime imports without starting sockets or migrations",
      "Prove financial journal custody with the actual Linux kernel and final keeper image",
      "Prove protected custody across PostgreSQL restart and restore",
      "Prove Vault reads through the final Keeper image and real managed Git files",
      "Prove root-only person erasure against the final Keeper image and Linux journal lock",
      "Prove disposable maintenance admission and external database HBA",
      "actions/upload-artifact@v4 keeper-maintenance-fence-proof [if: always()]",
      "Verify the box tooling loads and the engine unpacks",
      "Prove unpacked maintenance admission in independent Linux systemd services",
      "actions/upload-artifact@v4 keeper-and-network-image-scans [if: always()]",
      "Verify keeper runtime Docker tools and Compose parser",
      "Generate representative configs and validate with native target parsers",
      "Exercise final proxy policy and atomic reload on an isolated network",
      "actions/upload-artifact@v4 proxy-runtime-proof [if: always()]",
      "docker/build-push-action@v6 ghcr.io/heiberg-industries/lares-engine-keeper:sha-${{ github.sha }}",
      "docker/build-push-action@v6 ghcr.io/heiberg-industries/lares-engine-firewall-helper:sha-${{ github.sha }}",
      "docker/build-push-action@v6 ghcr.io/heiberg-industries/lares-engine-egress-proxy:sha-${{ github.sha }}",
    ],
  };

  it.each(BUILDING_JOBS)("the %s job still runs every step it ran, in order, each on its own condition", (job) => {
    expect(steps(job).map(label)).toEqual(STEPS[job]);
  });

  it("adds no step that reports on an image that was not built", () => {
    // The select job's summary is the only record of a kept image: no job, and no step in the
    // building jobs, exists to say "ok" for one.
    expect(Object.keys(workflow.jobs)).toHaveLength(1 + BUILDING_JOBS.length);
    expect(steps("select").map((step) => step.name ?? step.uses)).toEqual(["actions/checkout@v4", "Setup Node 24", "Select the images this change affects"]);
    for (const job of BUILDING_JOBS) for (const step of steps(job)) expect(step.if ?? "", `${job}: ${label(step)}`).not.toContain("needs.select");
  });

  it("the real install job still builds all six images it installs from", () => {
    const built = steps("real-install").filter((step) => step.uses?.startsWith("docker/build-push-action@")).map((step) => `${step.with!.file}${step.with!.target === undefined ? "" : ` (${step.with!.target})`}`);
    expect(built).toEqual([
      "services/keeper/Dockerfile",
      "images/egress-proxy/Dockerfile",
      "images/firewall-helper/Dockerfile",
      "services/console/Dockerfile",
      "services/chief-of-staff/Dockerfile (runtime)",
      "services/creative/Dockerfile (runtime)",
    ]);
  });
});
