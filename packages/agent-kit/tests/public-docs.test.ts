import { execFileSync } from "node:child_process";
import fs, { appendFileSync, chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_DOCS,
  createPublicDocsPublicationReceipt,
  exportPublicCorpus,
  verifyPublicCorpus,
  verifyPublicDocsPublicationReceipt,
} from "../src/public-docs.js";

const temporaryRoots: string[] = [];
const implementationRoot = path.resolve(import.meta.dirname, "../../..");

function temporaryDirectory(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lares-public-docs-")));
  temporaryRoots.push(root);
  return root;
}

function runGit(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitChanges(root: string): string {
  runGit(root, ["add", "--", ...["packages/agent-kit/src/public-docs.ts", "packages/agent-kit/package.json", "scripts/public-docs.ts", ...PUBLIC_DOCS.map((page) => page.sourcePath)]]);
  runGit(root, ["commit", "-qm", "fixture change"]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

function sourceRepository(): { root: string; commit: string } {
  const root = path.join(temporaryDirectory(), "source");
  mkdirSync(root, { recursive: true });
  for (const file of ["packages/agent-kit/src/public-docs.ts", "packages/agent-kit/package.json", "scripts/public-docs.ts", ...PUBLIC_DOCS.map((page) => page.sourcePath)]) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    if (file === "packages/agent-kit/src/public-docs.ts" || file === "packages/agent-kit/package.json" || file === "scripts/public-docs.ts") {
      copyFileSync(path.join(implementationRoot, file), target);
    } else {
      const page = PUBLIC_DOCS.find((entry) => entry.sourcePath === file)!;
      writeFileSync(target, `# ${page.title}\n\nExact public bytes for ${page.id}.\n`, { mode: 0o644 });
    }
  }
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.name", "Public docs test"]);
  runGit(root, ["config", "user.email", "public-docs-test@example.invalid"]);
  runGit(root, ["add", "--", ...["packages/agent-kit/src/public-docs.ts", "packages/agent-kit/package.json", "scripts/public-docs.ts", ...PUBLIC_DOCS.map((page) => page.sourcePath)]]);
  runGit(root, ["commit", "-qm", "fixture"]);
  return { root, commit: runGit(root, ["rev-parse", "HEAD"]) };
}

function exportSnapshot(root: string, release = "candidate", outputName = "snapshot") {
  const repo = sourceRepository();
  return exportSnapshotFromRepo(root, repo, release, outputName);
}

function exportSnapshotFromRepo(root: string, repo: { root: string; commit: string }, release = "candidate", outputName = "snapshot") {
  const outDir = path.join(root, outputName);
  const identity = exportPublicCorpus({ repoRoot: repo.root, sourceCommit: repo.commit, release, outDir });
  return { ...repo, outDir, identity };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release-pinned public docs corpus", () => {
  it("exports deterministic exact bytes and exposes only allowlisted IDs", () => {
    const root = temporaryDirectory();
    const repo = sourceRepository();
    const first = exportSnapshotFromRepo(root, repo, "candidate", "one");
    const second = exportSnapshotFromRepo(root, repo, "candidate", "two");
    expect(first.identity).toEqual(second.identity);
    const docs = verifyPublicCorpus(first.outDir, first.identity.corpusSha256);
    expect(docs.list().map(({ id }) => id)).toEqual(PUBLIC_DOCS.map(({ id }) => id));
    expect(docs.read("install")).toBe(readFileSync(path.join(first.root, "docs/install.md"), "utf8"));
    expect(() => docs.read("../install")).toThrow(/Unknown public documentation page/);
    expect(readFileSync(path.join(first.outDir, "index.json"))).toEqual(readFileSync(path.join(second.outDir, "index.json")));
    for (const page of PUBLIC_DOCS) {
      expect(readFileSync(path.join(first.outDir, page.filePath))).toEqual(readFileSync(path.join(second.outDir, page.filePath)));
    }
  });

  it("rejects a caller-supplied commit that is not the checked-out source", () => {
    const root = temporaryDirectory();
    const repo = sourceRepository();
    expect(() => exportPublicCorpus({ repoRoot: repo.root, sourceCommit: "0".repeat(40), release: "candidate", outDir: path.join(root, "snapshot") })).toThrow(/does not match/);
  });

  it("rejects hidden dirty source pages by comparing bytes with the named commit", () => {
    const root = temporaryDirectory();
    const repo = sourceRepository();
    runGit(repo.root, ["update-index", "--assume-unchanged", "docs/install.md"]);
    writeFileSync(path.join(repo.root, "docs/install.md"), "uncommitted replacement content\n");
    expect(runGit(repo.root, ["status", "--porcelain"])).toBe("");
    expect(() => exportPublicCorpus({
      repoRoot: repo.root, sourceCommit: repo.commit, release: "candidate", outDir: path.join(root, "hidden-dirty"),
    })).toThrow(/does not match its committed Git blob/);
  });

  it("rejects symlinked, multiply-linked, invalid UTF-8, and oversized source pages", () => {
    const root = temporaryDirectory();

    const symlinkRepo = sourceRepository();
    const symlinkSource = path.join(symlinkRepo.root, "docs/install.md");
    unlinkSync(symlinkSource);
    symlinkSync("install-with-an-agent.md", symlinkSource);
    const symlinkCommit = commitChanges(symlinkRepo.root);
    expect(() => exportPublicCorpus({ repoRoot: symlinkRepo.root, sourceCommit: symlinkCommit, release: "candidate", outDir: path.join(root, "symlink") })).toThrow(/symlink/);

    const hardlinkRepo = sourceRepository();
    const hardlinkSource = path.join(hardlinkRepo.root, "docs/install.md");
    unlinkSync(hardlinkSource);
    linkSync(path.join(hardlinkRepo.root, "docs/install-with-an-agent.md"), hardlinkSource);
    const hardlinkCommit = commitChanges(hardlinkRepo.root);
    expect(() => exportPublicCorpus({ repoRoot: hardlinkRepo.root, sourceCommit: hardlinkCommit, release: "candidate", outDir: path.join(root, "hardlink") })).toThrow(/one filesystem link/);

    const utf8Repo = sourceRepository();
    writeFileSync(path.join(utf8Repo.root, "docs/install.md"), Buffer.from([0xff, 0xfe]));
    const utf8Commit = commitChanges(utf8Repo.root);
    expect(() => exportPublicCorpus({ repoRoot: utf8Repo.root, sourceCommit: utf8Commit, release: "candidate", outDir: path.join(root, "utf8") })).toThrow(/valid UTF-8/);

    const largeRepo = sourceRepository();
    const largeSource = path.join(largeRepo.root, "docs/install.md");
    writeFileSync(largeSource, Buffer.alloc(1_000_001, 0x61));
    const largeCommit = commitChanges(largeRepo.root);
    const sourceOpen = vi.spyOn(fs, "openSync");
    try {
      expect(() => exportPublicCorpus({ repoRoot: largeRepo.root, sourceCommit: largeCommit, release: "candidate", outDir: path.join(root, "large") })).toThrow(/1000000-byte limit/);
      expect(sourceOpen.mock.calls.some(([file]) => file === largeSource)).toBe(false);
    } finally {
      sourceOpen.mockRestore();
    }
  });

  it("preserves a UTF-8 BOM through export and the public read API", () => {
    const root = temporaryDirectory();
    const repo = sourceRepository();
    const sourcePath = path.join(repo.root, "docs/install.md");
    const sourceBytes = readFileSync(sourcePath);
    writeFileSync(sourcePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), sourceBytes]));
    const commit = commitChanges(repo.root);
    const outDir = path.join(root, "bom-snapshot");
    const identity = exportPublicCorpus({ repoRoot: repo.root, sourceCommit: commit, release: "candidate", outDir });
    const docs = verifyPublicCorpus(outDir, identity.corpusSha256);
    expect(Buffer.from(docs.read("install"), "utf8")).toEqual(readFileSync(path.join(outDir, "pages/install.md")));
  });

  it("refuses dirty allowlisted inputs, output paths inside the repo, and non-release labels", () => {
    const root = temporaryDirectory();
    const repo = sourceRepository();
    writeFileSync(path.join(repo.root, "docs/install.md"), "changed\n");
    expect(() => exportPublicCorpus({ repoRoot: repo.root, sourceCommit: repo.commit, release: "candidate", outDir: path.join(root, "snapshot") })).toThrow(/does not match its committed Git blob/);

    const cleanRepo = sourceRepository();
    expect(() => exportPublicCorpus({ repoRoot: cleanRepo.root, sourceCommit: cleanRepo.commit, release: "rc.13", outDir: path.join(root, "bad-label") })).toThrow(/full dated/);
    expect(() => exportPublicCorpus({ repoRoot: cleanRepo.root, sourceCommit: cleanRepo.commit, release: "2026-99-99-rc.13", outDir: path.join(root, "bad-date") })).toThrow(/valid calendar date/);
    expect(() => exportPublicCorpus({ repoRoot: cleanRepo.root, sourceCommit: cleanRepo.commit, release: "candidate", outDir: path.join(cleanRepo.root, "snapshot") })).toThrow(/outside the source repository/);
  });

  it("rejects modified pages, modified index metadata, and unknown extra files", () => {
    const root = temporaryDirectory();
    const first = exportSnapshot(root, "candidate", "content-tamper");
    chmodSync(path.join(first.outDir, "pages/install.md"), 0o644);
    writeFileSync(path.join(first.outDir, "pages/install.md"), "tampered\n");
    expect(() => verifyPublicCorpus(first.outDir, first.identity.corpusSha256)).toThrow(/failed integrity|size does not match/);

    const second = exportSnapshot(root, "candidate", "index-tamper");
    chmodSync(path.join(second.outDir, "index.json"), 0o644);
    writeFileSync(path.join(second.outDir, "index.json"), `${readFileSync(path.join(second.outDir, "index.json"), "utf8")} `);
    expect(() => verifyPublicCorpus(second.outDir, second.identity.corpusSha256)).toThrow(/canonical format/);

    const third = exportSnapshot(root, "candidate", "extra-file");
    writeFileSync(path.join(third.outDir, "unexpected.txt"), "not public corpus data");
    expect(() => verifyPublicCorpus(third.outDir, third.identity.corpusSha256)).toThrow(/missing or unexpected files/);

    const fourth = exportSnapshot(root, "candidate", "symlink-file");
    symlinkSync("install.md", path.join(fourth.outDir, "pages/alias.md"));
    expect(() => verifyPublicCorpus(fourth.outDir, fourth.identity.corpusSha256)).toThrow(/symlink/);

    const missing = exportSnapshot(root, "candidate", "missing-file");
    unlinkSync(path.join(missing.outDir, "pages/using-the-console.md"));
    expect(() => verifyPublicCorpus(missing.outDir, missing.identity.corpusSha256)).toThrow(/missing or unexpected files/);

    const fifth = exportSnapshot(root, "candidate", "duplicate-id");
    const indexPath = path.join(fifth.outDir, "index.json");
    chmodSync(indexPath, 0o644);
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as { pages: Array<Record<string, unknown>> };
    index.pages[1]!.id = "install";
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    expect(() => verifyPublicCorpus(fifth.outDir, fifth.identity.corpusSha256)).toThrow(/reviewed public allowlist/);

    const reordered = exportSnapshot(root, "candidate", "reordered-index");
    const reorderedPath = path.join(reordered.outDir, "index.json");
    const parsed = JSON.parse(readFileSync(reorderedPath, "utf8")) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    chmodSync(reorderedPath, 0o644);
    writeFileSync(reorderedPath, `${JSON.stringify(reversed, null, 2)}\n`);
    expect(() => verifyPublicCorpus(reordered.outDir, reordered.identity.corpusSha256)).toThrow(/canonical format/);
  });

  it("enforces index and page byte limits before opening their contents", () => {
    const root = temporaryDirectory();
    const oversizedIndex = exportSnapshot(root, "candidate", "oversized-index");
    const indexPath = path.join(oversizedIndex.outDir, "index.json");
    chmodSync(indexPath, 0o644);
    writeFileSync(indexPath, Buffer.alloc(64_001, 0x20));
    const indexOpen = vi.spyOn(fs, "openSync");
    try {
      expect(() => verifyPublicCorpus(oversizedIndex.outDir, oversizedIndex.identity.corpusSha256)).toThrow(/64000-byte limit/);
      expect(indexOpen.mock.calls.some(([file]) => file === indexPath)).toBe(false);
    } finally {
      indexOpen.mockRestore();
    }

    const oversizedPage = exportSnapshot(root, "candidate", "oversized-page");
    const pagePath = path.join(oversizedPage.outDir, "pages/install.md");
    chmodSync(pagePath, 0o644);
    writeFileSync(pagePath, Buffer.alloc(1_000_001, 0x61));
    const pageOpen = vi.spyOn(fs, "openSync");
    try {
      expect(() => verifyPublicCorpus(oversizedPage.outDir, oversizedPage.identity.corpusSha256)).toThrow(/1000000-byte limit/);
      expect(pageOpen.mock.calls.some(([file]) => file === pagePath)).toBe(false);
    } finally {
      pageOpen.mockRestore();
    }
  });

  it("rejects a page that grows between its path check and bounded descriptor read", () => {
    const root = temporaryDirectory();
    const snapshot = exportSnapshot(root, "candidate", "growing-page");
    const pagePath = path.join(snapshot.outDir, "pages/install.md");
    chmodSync(pagePath, 0o644);
    const originalOpen = fs.openSync.bind(fs);
    let grew = false;
    const open = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      const descriptor = originalOpen(...args);
      if (!grew && args[0] === pagePath) {
        grew = true;
        appendFileSync(pagePath, "extra byte");
      }
      return descriptor;
    });
    try {
      expect(() => verifyPublicCorpus(snapshot.outDir, snapshot.identity.corpusSha256)).toThrow(/changed identity before it could be read/);
      expect(grew).toBe(true);
    } finally {
      open.mockRestore();
    }
  });

  it("binds a full release corpus to exact finalized manifest bytes without claiming website publication", () => {
    const root = temporaryDirectory();
    const release = "2026-10-23-rc.13";
    const snapshot = exportSnapshot(root, release, "release-snapshot");
    const manifestPath = path.join(root, "release.json");
    const receiptPath = path.join(root, "receipt.json");
    writeFileSync(manifestPath, `${JSON.stringify({ release, images: { engine: "sha256:abc" } }, null, 2)}\n`);
    const receipt = createPublicDocsPublicationReceipt({
      snapshotDir: snapshot.outDir,
      releaseManifestPath: manifestPath,
      outputPath: receiptPath,
      expectedCorpusSha256: snapshot.identity.corpusSha256,
    });
    expect(receipt).toMatchObject(snapshot.identity);
    expect(Object.keys(receipt).sort()).toEqual(["corpusSha256", "release", "releaseManifestSha256", "schemaVersion", "sourceCommit", "type"].sort());
    expect(verifyPublicDocsPublicationReceipt({ receiptPath, releaseManifestPath: manifestPath, expected: snapshot.identity })).toEqual(receipt);
    expect(() => verifyPublicDocsPublicationReceipt({
      receiptPath, releaseManifestPath: manifestPath,
      expected: { ...snapshot.identity, sourceCommit: "0".repeat(40) },
    })).toThrow(/trusted public-docs identity/);

    writeFileSync(manifestPath, `${JSON.stringify({ release, images: { engine: "sha256:changed" } }, null, 2)}\n`);
    expect(() => verifyPublicDocsPublicationReceipt({ receiptPath, releaseManifestPath: manifestPath, expected: snapshot.identity })).toThrow(/manifest bytes/);

    writeFileSync(manifestPath, `${JSON.stringify({ release: "2026-10-23-rc.14" }, null, 2)}\n`);
    expect(() => createPublicDocsPublicationReceipt({
      snapshotDir: snapshot.outDir, releaseManifestPath: manifestPath,
      outputPath: path.join(root, "mismatched-receipt.json"), expectedCorpusSha256: snapshot.identity.corpusSha256,
    })).toThrow(/does not match the expected release/);
  });

  it("bounds receipt and release-manifest reads before opening oversized files", () => {
    const root = temporaryDirectory();
    const snapshot = exportSnapshot(root, "2026-10-23-rc.13", "bounded-receipt");
    const manifestPath = path.join(root, "bounded-release.json");
    const receiptPath = path.join(root, "bounded-receipt.json");
    writeFileSync(manifestPath, `${JSON.stringify({ release: snapshot.identity.release })}\n`);
    createPublicDocsPublicationReceipt({
      snapshotDir: snapshot.outDir, releaseManifestPath: manifestPath, outputPath: receiptPath,
      expectedCorpusSha256: snapshot.identity.corpusSha256,
    });
    const validReceipt = readFileSync(receiptPath);

    chmodSync(receiptPath, 0o644);
    writeFileSync(receiptPath, Buffer.alloc(8_001, 0x20));
    const receiptOpen = vi.spyOn(fs, "openSync");
    try {
      expect(() => verifyPublicDocsPublicationReceipt({ receiptPath, releaseManifestPath: manifestPath, expected: snapshot.identity })).toThrow(/8000-byte limit/);
      expect(receiptOpen.mock.calls.some(([file]) => file === receiptPath)).toBe(false);
    } finally {
      receiptOpen.mockRestore();
    }

    writeFileSync(receiptPath, validReceipt);
    chmodSync(manifestPath, 0o644);
    writeFileSync(manifestPath, Buffer.alloc(256_001, 0x20));
    const manifestOpen = vi.spyOn(fs, "openSync");
    try {
      expect(() => verifyPublicDocsPublicationReceipt({ receiptPath, releaseManifestPath: manifestPath, expected: snapshot.identity })).toThrow(/256000-byte limit/);
      expect(manifestOpen.mock.calls.some(([file]) => file === manifestPath)).toBe(false);
    } finally {
      manifestOpen.mockRestore();
    }
  });

  it("does not create a release receipt for candidate snapshots or mismatched corpus hashes", () => {
    const root = temporaryDirectory();
    const snapshot = exportSnapshot(root, "candidate", "candidate-snapshot");
    const manifestPath = path.join(root, "release.json");
    writeFileSync(manifestPath, `${JSON.stringify({ release: "2026-10-23-rc.13" })}\n`);
    expect(() => createPublicDocsPublicationReceipt({
      snapshotDir: snapshot.outDir, releaseManifestPath: manifestPath,
      outputPath: path.join(root, "candidate-receipt.json"), expectedCorpusSha256: snapshot.identity.corpusSha256,
    })).toThrow(/candidate corpus/);
    expect(() => verifyPublicCorpus(snapshot.outDir, "f".repeat(64))).toThrow(/trusted expected hash/);
    expect(() => verifyPublicCorpus(snapshot.outDir, undefined as unknown as string)).toThrow(/trusted expected/);
  });
});
