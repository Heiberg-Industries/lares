// publish-test-release-workflow.test.ts — the entry workflow, read from the file itself: what it
// may write, what it may call, that nothing in it pushes main, and that its actions are pinned.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEXT = readFileSync(join(REPO, ".github", "workflows", "publish-test-release.yml"), "utf8");
const workflow = parse(TEXT);

describe("the publish test release workflow", () => {
  it("starts only by hand, one run at a time, and publishes nothing unless asked", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false);
    expect(workflow.on.workflow_dispatch.inputs.release.required).toBe(true);
    expect(workflow.concurrency).toEqual({ group: "publish-test-release", "cancel-in-progress": false });
  });

  it("gives write access only where something is pushed", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    const writes = Object.entries<any>(workflow.jobs).filter(([, job]) => Object.values(job.permissions ?? {}).includes("write")).map(([id, job]) => [id, job.permissions]);
    expect(writes).toEqual([
      ["keeper-runtime", { contents: "read", packages: "write" }],
      ["console", { contents: "read", packages: "write" }],
      ["sync-jobs", { contents: "read", packages: "write" }],
      ["record", { contents: "write", actions: "read" }],
    ]);
    expect(workflow.jobs.plan.permissions).toEqual({ contents: "read" });
  });

  it("calls the existing image workflows and builds nothing itself", () => {
    expect(workflow.jobs["keeper-runtime"].uses).toBe("./.github/workflows/keeper-runtime-images.yml");
    expect(workflow.jobs.console.uses).toBe("./.github/workflows/console-image.yml");
    expect(workflow.jobs["sync-jobs"].uses).toBe("./.github/workflows/sync-jobs-image.yml");
    expect(TEXT).not.toMatch(/build-push-action|docker\/login-action/);
  });

  it("pins every action by commit, and never pushes main or opens a pull request itself", () => {
    const uses = [...TEXT.matchAll(/^\s+- uses: (\S+)/gm)].map((match) => match[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const reference of uses) expect(reference, reference).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    expect(TEXT).not.toMatch(/git push[^\n]*\bmain\b/);
    expect(TEXT).toContain('git push origin "release/$RELEASE"');
    // The pull-request line is printed for a person to run, never run here.
    expect(TEXT).not.toMatch(/^\s+gh pr create/m);
    expect(TEXT).not.toMatch(/secrets\./);
  });

  it("writes the record only when every needed image is done", () => {
    const record = workflow.jobs.record;
    expect(record.needs).toEqual(["plan", "keeper-runtime", "console", "sync-jobs"]);
    expect(record.if).toContain("!contains(needs.*.result, 'failure')");
    expect(record.if).toContain("!contains(needs.*.result, 'cancelled')");
    expect(record.if).toContain("needs.plan.result == 'success'");
  });

  it("passes user input to scripts only through the environment", () => {
    for (const job of Object.values<any>(workflow.jobs)) {
      for (const step of job.steps ?? []) expect(String(step.run ?? ""), step.name).not.toContain("${{");
    }
  });
});
