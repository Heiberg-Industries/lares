import { describe, expect, it } from "vitest";
import { noteScope } from "../src/notes-store.js";

describe("noteScope — frontmatter to scope, store default as fallback", () => {
  it("reads an explicit scope with participants", () => {
    const raw = "---\nscope: participants\nparticipants: [bendik, stefan]\n---\n# Board sync\n";
    expect(noteScope(raw, "brain")).toEqual({ scope: "participants", participants: ["bendik", "stefan"], owner: undefined });
  });

  it("reads an explicit private scope with an owner", () => {
    const raw = "---\nscope: private\nowner: bendik\n---\nnote\n";
    expect(noteScope(raw, "atlas")).toEqual({ scope: "private", participants: [], owner: "bendik" });
  });

  it("defaults brain to private and atlas to org when no frontmatter exists", () => {
    expect(noteScope("# plain note\n", "brain").scope).toBe("private");
    expect(noteScope("# plain note\n", "atlas").scope).toBe("org");
  });

  it("an unknown scope value never widens: brain falls to private, atlas to its default", () => {
    const raw = "---\nscope: everyone\n---\nx\n";
    expect(noteScope(raw, "brain").scope).toBe("private");
    expect(noteScope(raw, "atlas").scope).toBe("org");
  });
});
