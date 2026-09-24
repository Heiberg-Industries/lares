// The shape half of the create guard (T3b). Every case here is a path a Notion
// title or Folder property could actually produce — this is the only write in the
// service whose target is derived from content rather than from a file already on
// disk.
import { describe, it, expect } from "vitest";
import { refuseVaultTarget } from "../lib/vault-target.js";

describe("refuseVaultTarget — paths a create may target", () => {
  it("allows an ordinary desk file", () => {
    expect(refuseVaultTarget("zero7/transcripts/2026-08-05-standup.md")).toBeNull();
  });

  it("allows a file at the vault root", () => {
    expect(refuseVaultTarget("inbox.md")).toBeNull();
  });

  it("allows unicode, spaces and punctuation — real note titles have all three", () => {
    expect(refuseVaultTarget("Heiberg Industries/møte — 5. august (utkast).md")).toBeNull();
  });

  it("allows .MD as well as .md — the vault walkers match case-insensitively", () => {
    expect(refuseVaultTarget("zero7/NOTE.MD")).toBeNull();
  });
});

describe("refuseVaultTarget — escapes", () => {
  it("refuses an absolute path", () => {
    expect(refuseVaultTarget("/etc/cron.d/payload.md")).toMatch(/absolute/i);
  });

  it("refuses a path that walks out of the vault", () => {
    expect(refuseVaultTarget("../../etc/passwd.md")).toMatch(/walks the tree/i);
  });

  // Stays inside the vault, so nothing downstream would stop it — and that is the
  // point: the store row would be keyed on a path that is not its own canonical
  // form, so it joins to the file on disk never.
  it("refuses a `..` that stays inside the vault", () => {
    expect(refuseVaultTarget("zero7/../orakel/note.md")).toMatch(/walks the tree/i);
  });

  it("refuses a `.` segment", () => {
    expect(refuseVaultTarget("zero7/./note.md")).toMatch(/walks the tree/i);
  });

  it("refuses an empty segment", () => {
    expect(refuseVaultTarget("zero7//note.md")).toMatch(/empty path segment/i);
  });

  it("refuses an empty or whitespace-only path", () => {
    expect(refuseVaultTarget("")).toMatch(/empty/i);
    expect(refuseVaultTarget("   ")).toMatch(/empty/i);
  });

  // A `deskDirs[].exclude` entry padded with a space is the malformation config.ts
  // calls the one an operator cannot see. The same is true of a path.
  it("refuses a path padded with whitespace", () => {
    expect(refuseVaultTarget(" zero7/note.md")).toMatch(/whitespace/i);
    expect(refuseVaultTarget("zero7/note.md ")).toMatch(/whitespace/i);
  });

  // Checked per SEGMENT, not once over the whole string: all three of these trim
  // clean as a path and each makes a second, visually identical folder or file.
  // A Notion `Folder` property with a trailing space is the ordinary way to get one.
  it("refuses whitespace padding INSIDE the path, not just at its ends", () => {
    expect(refuseVaultTarget("zero7 /note.md")).toMatch(/segment is padded/i);
    expect(refuseVaultTarget("zero7/ note.md")).toMatch(/segment is padded/i);
    // The one no segment-edge check can see: the space sits BETWEEN the stem and
    // the extension, so the segment itself trims clean. It is what a Notion title
    // with a trailing space produces once a slug is suffixed with ".md".
    expect(refuseVaultTarget("zero7/note .md")).toMatch(/stem is padded/i);
    // …and a space in the MIDDLE of a name is perfectly ordinary.
    expect(refuseVaultTarget("Heiberg Industries/my note.md")).toBeNull();
    expect(refuseVaultTarget("zero7/Q3 review.md")).toBeNull();
  });
});

describe("refuseVaultTarget — length, in bytes", () => {
  // The reason this is a guard and not a filesystem error: a create that fails at
  // the write has no doc row for recordDocError to reach, so ENAMETOOLONG would be
  // an hourly retry that persists nothing and pings nobody.
  it("refuses a component too long for NAME_MAX", () => {
    expect(refuseVaultTarget(`zero7/${"a".repeat(201)}.md`)).toMatch(/segment is too long/i);
  });

  // Character counting is the bug this avoids: these are Norwegian titles, and
  // every æ/ø/å is two bytes in UTF-8. 150 characters is 300 bytes — well past
  // NAME_MAX while looking short to a naive `.length` check.
  it("counts BYTES, not characters — a Norwegian title is not its character count", () => {
    const norwegian = "æ".repeat(150);
    expect(norwegian.length).toBeLessThan(201);          // passes a character check…
    expect(refuseVaultTarget(`zero7/${norwegian}.md`)).toMatch(/too long/i);   // …and fails this one
  });

  it("refuses a whole path that is too long even with short components", () => {
    const deep = Array.from({ length: 60 }, (_, i) => `folder-${i}-${"x".repeat(10)}`).join("/");
    expect(refuseVaultTarget(`zero7/${deep}/note.md`)).toMatch(/path is too long/i);
  });

  // The whole-path cap counts bytes too, not just the per-segment one. With ASCII
  // `length` and byteLength agree, so an ASCII-only test cannot tell the two apart —
  // and these are Norwegian folder names.
  it("counts BYTES for the whole path as well", () => {
    // 12 segments of 60 Norwegian characters = 120 bytes each: every segment is
    // comfortably under the component cap, and the path is over the total.
    const segments = Array.from({ length: 12 }, () => "æ".repeat(60));
    const path = `${segments.join("/")}/note.md`;
    expect(path.length).toBeLessThan(1024);                  // passes a character check…
    expect(refuseVaultTarget(path)).toMatch(/path is too long/i);   // …and fails this one
  });

  it("allows a long-but-reasonable meeting slug", () => {
    expect(refuseVaultTarget(`zero7/transcripts/2026-08-05-${"a".repeat(120)}.md`)).toBeNull();
  });

  it("refuses a control character — a Notion title can contain a newline", () => {
    expect(refuseVaultTarget("zero7/note\nrm -rf.md")).toMatch(/control character/i);
    expect(refuseVaultTarget("zero7/note\u0000.md")).toMatch(/control character/i);
  });
});

describe("refuseVaultTarget — machine-owned areas", () => {
  it("refuses the wiki mirror", () => {
    expect(refuseVaultTarget("wiki/note.md")).toMatch(/one-way mirror/i);
  });

  // The whole reason this matches segments and not string prefixes.
  it("allows a folder that merely STARTS with the mirror's name", () => {
    expect(refuseVaultTarget("wikipedia/note.md")).toBeNull();
    expect(refuseVaultTarget("wiki-drafts/note.md")).toBeNull();
  });

  // wikiDir is anchored at the vault root (config.ts refuses a deskDirs entry that
  // overlaps it), so a nested folder called "wiki" is a human's, not the mirror.
  it("allows a nested folder called wiki", () => {
    expect(refuseVaultTarget("orakel/wiki/note.md")).toBeNull();
  });

  // The vault is also cloned onto a case-insensitive Mac filesystem, where WIKI/ IS
  // the mirror. The guard must not depend on which machine it runs on.
  it("refuses the machine-owned names whatever their case", () => {
    expect(refuseVaultTarget("WIKI/note.md")).toMatch(/one-way mirror/i);
    expect(refuseVaultTarget("zero7/_Archive/note.md")).toMatch(/_Archive/);
  });

  it("refuses _archive and _meta anywhere in the path", () => {
    expect(refuseVaultTarget("_archive/note.md")).toMatch(/_archive/);
    expect(refuseVaultTarget("zero7/_archive/note.md")).toMatch(/_archive/);
    expect(refuseVaultTarget("_meta/note.md")).toMatch(/_meta/);
  });

  it("allows a folder that merely starts with an owned name", () => {
    expect(refuseVaultTarget("_archived-notes/note.md")).toBeNull();
  });

  it("refuses any dot-directory or dotfile", () => {
    expect(refuseVaultTarget(".git/hooks/pre-commit.md")).toMatch(/dot-directory/i);
    expect(refuseVaultTarget("zero7/.obsidian/workspace.md")).toMatch(/dot-directory/i);
    expect(refuseVaultTarget("zero7/.hidden.md")).toMatch(/dot-directory/i);
  });
});

describe("refuseVaultTarget — markdown only", () => {
  it("refuses anything that is not a .md file", () => {
    expect(refuseVaultTarget("zero7/deploy.sh")).toMatch(/not a markdown file/i);
    expect(refuseVaultTarget("zero7/config.yml")).toMatch(/not a markdown file/i);
    expect(refuseVaultTarget("zero7/note")).toMatch(/not a markdown file/i);
  });
});
