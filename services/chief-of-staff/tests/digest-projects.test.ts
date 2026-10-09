/**
 * The engine ships no project names: the projects a transcript may be filed under come from the
 * private store at run time, and the model prompt names nobody.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { classifyItem, type ClassifyContext } from "../lib/digest/classifier.js";
import { listTranscriptProjects } from "../lib/digest/filer.js";
import { runDigest, type RunnerDeps } from "../lib/digest/runner.js";
import * as types from "../lib/digest/types.js";

const reply = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ route: "file", type: "transcript", project: "project-a", title: "Call", summary: "S", links: [], reason: "clear", ...over });

const ctx = (over: Partial<ClassifyContext> = {}): ClassifyContext => ({ projects: ["project-a", "project-b"], noteNames: [], ...over });

describe("the classifier prompt names nobody", () => {
  it("speaks of the owner in general terms and lists only the injected projects", async () => {
    const prompts: string[] = [];
    await classifyItem({ path: "_inbox/x.md", body: "a call" }, ctx({ contextNote: "a note" }), async (p) => {
      prompts.push(p);
      return reply();
    });
    const prompt = prompts[0]!;
    expect(prompt).toContain("the owner's private notes");
    expect(prompt).toContain("Context note from the owner");
    expect(prompt).toContain("The project MUST be one of: project-a, project-b.");
    expect(prompt).not.toMatch(/\b(?:Brain|knowledge base)\b/);
  });

  it("the project list in the prompt is whatever was injected", async () => {
    const prompts: string[] = [];
    await classifyItem({ path: "_inbox/x.md", body: "b" }, ctx({ projects: ["alpha", "beta"] }), async (p) => {
      prompts.push(p);
      return reply({ project: "alpha" });
    });
    expect(prompts[0]).toContain("The project MUST be one of: alpha, beta.");
  });

  it("the engine exports no project list", () => {
    expect("PROJECTS" in types).toBe(false);
  });
});

describe("classifyItem with the injected projects", () => {
  it("files a transcript under an injected project", async () => {
    const d = await classifyItem({ path: "_inbox/x.md", body: "b" }, ctx(), async () => reply());
    expect(d.route).toBe("file");
    expect(d.destination).toBe("project-a/transcripts");
  });

  it("asks when the project is not in the list", async () => {
    const d = await classifyItem({ path: "_inbox/x.md", body: "b" }, ctx(), async () => reply({ project: "project-z", reason: "" }));
    expect(d.route).toBe("ask");
    expect(d.reason).toContain("project unclear");
  });

  it("an empty list works: the prompt says so and a transcript is asked about", async () => {
    const prompts: string[] = [];
    const d = await classifyItem({ path: "_inbox/x.md", body: "b" }, ctx({ projects: [] }), async (p) => {
      prompts.push(p);
      return reply();
    });
    expect(prompts[0]).toContain("No project has a transcripts/ folder yet");
    expect(prompts[0]).not.toContain("MUST be one of");
    expect(d.route).toBe("ask");
    expect(d.destination).toBe("");
  });
});

describe("runDigest takes the projects from its dependencies", () => {
  const deps = (projects: string[], seen: string[]): RunnerDeps => ({
    agent: "agent-a",
    listInbox: async () => [{ path: "_inbox/call.md", body: "a transcript" }],
    alreadySkipped: async () => [],
    noteNames: async () => [],
    projects: async () => projects,
    llm: async (p) => { seen.push(p); return reply(); },
    fileNote: async () => ({ commit: "abc1234" }),
    recordSkip: async () => {},
    post: async () => {},
    mode: "on-demand",
    capturedAt: "2026-10-09",
  });

  it("files into an injected project", async () => {
    const seen: string[] = [];
    const summary = await runDigest(deps(["project-a"], seen));
    expect(seen[0]).toContain("The project MUST be one of: project-a.");
    expect(summary.filed).toEqual([{ title: "Call", destination: "project-a/transcripts" }]);
  });

  it("with no projects the transcript is asked about, not filed", async () => {
    const seen: string[] = [];
    const summary = await runDigest(deps([], seen));
    expect(summary.filed).toEqual([]);
    expect(summary.asked).toHaveLength(1);
    expect(summary.errors).toEqual([]);
  });
});

describe("listTranscriptProjects reads the private store", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "digest-projects-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("lists top-level folders that have a transcripts/ folder, sorted, and nothing else", () => {
    for (const d of ["project-b/transcripts", "project-a/transcripts", "no-transcripts/notes", "_inbox/transcripts", ".git/transcripts"]) {
      mkdirSync(join(root, d), { recursive: true });
    }
    writeFileSync(join(root, "loose.md"), "x");
    mkdirSync(join(root, "file-not-folder"));
    writeFileSync(join(root, "file-not-folder", "transcripts"), "a file, not a folder");
    expect(listTranscriptProjects(root)).toEqual(["project-a", "project-b"]);
  });

  it("leaves out symlinked project folders and symlinked transcripts folders", () => {
    const outside = mkdtempSync(join(tmpdir(), "digest-projects-outside-"));
    try {
      mkdirSync(join(outside, "transcripts"));
      mkdirSync(join(root, "real/transcripts"), { recursive: true });
      symlinkSync(outside, join(root, "escape"));
      symlinkSync(join(root, "real"), join(root, "alias"));
      mkdirSync(join(root, "linked-transcripts"));
      symlinkSync(join(outside, "transcripts"), join(root, "linked-transcripts", "transcripts"));
      expect(listTranscriptProjects(root)).toEqual(["real"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("leaves out a folder name with a comma, since the prompt lists projects separated by commas", () => {
    mkdirSync(join(root, "a, b/transcripts"), { recursive: true });
    mkdirSync(join(root, "project-a/transcripts"), { recursive: true });
    expect(listTranscriptProjects(root)).toEqual(["project-a"]);
  });

  it("keeps a project name with a space, and files a transcript under it", async () => {
    mkdirSync(join(root, "Project B/transcripts"), { recursive: true });
    const projects = listTranscriptProjects(root);
    expect(projects).toEqual(["Project B"]);
    const d = await classifyItem({ path: "_inbox/x.md", body: "b" }, ctx({ projects }), async () => reply({ project: "Project B" }));
    expect(d.route).toBe("file");
    expect(d.destination).toBe("Project B/transcripts");
  });

  it("an empty or missing store gives an empty list", () => {
    expect(listTranscriptProjects(root)).toEqual([]);
    expect(listTranscriptProjects(join(root, "missing"))).toEqual([]);
  });
});
