import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";

export const PUBLIC_DOCS_SCHEMA_VERSION = 1 as const;
export const MAX_PUBLIC_DOC_BYTES = 1_000_000;
export const MAX_PUBLIC_CORPUS_BYTES = 4_000_000;
const MAX_INDEX_BYTES = 64_000;
const MAX_RECEIPT_BYTES = 8_000;
const MAX_RELEASE_MANIFEST_BYTES = 256_000;
const MAX_PROVENANCE_FILE_BYTES = 2_000_000;

export const PUBLIC_DOCS = Object.freeze([
  Object.freeze({ id: "install", sourcePath: "docs/install.md", filePath: "pages/install.md", title: "Install Lares", route: "/docs/installation" }),
  Object.freeze({ id: "install-with-agent", sourcePath: "docs/install-with-an-agent.md", filePath: "pages/install-with-agent.md", title: "Install Lares with a coding agent", route: "/docs/install-with-an-agent" }),
  Object.freeze({ id: "using-the-console", sourcePath: "docs/how-to/using-the-console.md", filePath: "pages/using-the-console.md", title: "Using the console", route: "/docs/console" }),
]);

export interface PublicDocsIdentity {
  readonly release: string;
  readonly sourceCommit: string;
  readonly corpusSha256: string;
}

export interface PublicDocMetadata {
  readonly id: string;
  readonly sourcePath: string;
  readonly filePath: string;
  readonly title: string;
  readonly route: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface SnapshotPage extends PublicDocMetadata {}
interface SnapshotCore {
  readonly schemaVersion: typeof PUBLIC_DOCS_SCHEMA_VERSION;
  readonly release: string;
  readonly sourceCommit: string;
  readonly pages: readonly SnapshotPage[];
}
interface SnapshotManifest extends SnapshotCore { readonly corpusSha256: string }

export interface VerifiedPublicDocs extends PublicDocsIdentity {
  readonly pages: readonly PublicDocMetadata[];
  list(): readonly PublicDocMetadata[];
  read(id: string): string;
}

export interface ExportPublicCorpusOptions {
  repoRoot: string;
  sourceCommit: string;
  /** `candidate` is for non-release validation. A published snapshot uses its full dated RC name. */
  release: string;
  outDir: string;
}

export interface PublicationReceiptOptions {
  snapshotDir: string;
  releaseManifestPath: string;
  outputPath: string;
  expectedCorpusSha256: string;
}

export interface VerifyPublicationReceiptOptions {
  receiptPath: string;
  releaseManifestPath: string;
  expected: PublicDocsIdentity;
}

export interface PublicDocsPublicationReceipt extends PublicDocsIdentity {
  readonly schemaVersion: typeof PUBLIC_DOCS_SCHEMA_VERSION;
  readonly type: "lares-public-docs-release-binding";
  readonly releaseManifestSha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const RELEASE = /^\d{4}-\d{2}-\d{2}-rc\.\d+$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const knownIds = new Set<string>(PUBLIC_DOCS.map((entry) => entry.id));

if (knownIds.size !== PUBLIC_DOCS.length || new Set(PUBLIC_DOCS.map((entry) => entry.route)).size !== PUBLIC_DOCS.length ||
    PUBLIC_DOCS.some((entry) => !ID.test(entry.id) || !entry.sourcePath.startsWith("docs/") || path.isAbsolute(entry.sourcePath) ||
      entry.sourcePath.split(/[\\/]/).some((part) => part === "." || part === "..") ||
      !entry.filePath.startsWith("pages/") || entry.filePath.split(/[\\/]/).some((part) => part === "." || part === "..") ||
      !entry.route.startsWith("/docs/") || entry.route.includes("..") || !entry.title.trim())) {
  throw new Error("Public documentation allowlist contains duplicate IDs or routes");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function parseJson(bytes: Buffer, label: string): Record<string, unknown> {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  try {
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function assertNoSymlinkPath(absolutePath: string): void {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function assertRegularSingleLink(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a regular file with one filesystem link`);
  }
}

function assertAbsoluteOutsideRoot(targetPath: string, root: string, label: string): string {
  if (!path.isAbsolute(targetPath)) throw new Error(`${label} must be an absolute path`);
  const resolved = path.resolve(targetPath);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} must be outside the source repository`);
  }
  assertNoSymlinkPath(path.dirname(resolved));
  return resolved;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Read only a bounded regular, single-link file and verify its descriptor/path identity stayed stable. */
function readBoundedRegularFile(filePath: string, label: string, maxBytes: number, expectedBytes?: number): Buffer {
  assertNoSymlinkPath(filePath);
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`${label} must be a regular file with one filesystem link`);
  }
  if (before.size > BigInt(maxBytes)) throw new Error(`${label} exceeds its ${maxBytes}-byte limit`);
  if (expectedBytes !== undefined && before.size !== BigInt(expectedBytes)) throw new Error(`${label} size does not match its verified metadata`);

  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(before, opened)) {
      throw new Error(`${label} changed identity before it could be read`);
    }
    if (opened.size > BigInt(maxBytes)) throw new Error(`${label} exceeds its ${maxBytes}-byte limit`);
    if (expectedBytes !== undefined && opened.size !== BigInt(expectedBytes)) throw new Error(`${label} size does not match its verified metadata`);

    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${label} was shortened while it was read`);
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (fs.readSync(descriptor, extra, 0, 1, bytes.length) !== 0) throw new Error(`${label} grew while it was read`);

    const after = fs.fstatSync(descriptor, { bigint: true });
    const namedAfter = fs.lstatSync(filePath, { bigint: true });
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(opened, namedAfter) || namedAfter.nlink !== 1n) {
      throw new Error(`${label} changed identity while it was read`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readCommitBlob(root: string, commit: string, sourcePath: string, maxBytes: number): Buffer {
  const object = `${commit}:${sourcePath}`;
  const sizeText = git(root, ["cat-file", "-s", object]);
  if (!/^\d+$/.test(sizeText)) throw new Error(`Committed source ${sourcePath} has an invalid blob size`);
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size > maxBytes) throw new Error(`Committed source ${sourcePath} exceeds its ${maxBytes}-byte limit`);
  const bytes = execFileSync("git", ["-C", root, "cat-file", "blob", object], { maxBuffer: maxBytes + 1 });
  if (bytes.length !== size) throw new Error(`Committed source ${sourcePath} changed while it was read`);
  return bytes;
}

function assertMatchesCommittedBlob(root: string, commit: string, sourcePath: string, maxBytes: number): Buffer {
  const actual = readBoundedRegularFile(path.join(root, sourcePath), `Source ${sourcePath}`, maxBytes);
  const expected = readCommitBlob(root, commit, sourcePath, maxBytes);
  if (actual.length !== expected.length) throw new Error(`Source ${sourcePath} does not match its committed Git blob`);
  if (!actual.equals(expected)) throw new Error(`Source ${sourcePath} does not match its committed Git blob`);
  return actual;
}

function verifySourceCheckout(repoRoot: string, sourceCommit: string): string {
  if (!FULL_COMMIT.test(sourceCommit)) throw new Error("sourceCommit must be a full 40-character Git commit");
  const root = fs.realpathSync(repoRoot);
  const actualCommit = git(root, ["rev-parse", "HEAD"]);
  if (actualCommit !== sourceCommit) throw new Error("sourceCommit does not match the checked-out source");
  const paths = [
    "packages/agent-kit/src/public-docs.ts",
    "packages/agent-kit/package.json",
    "scripts/public-docs.ts",
  ];
  for (const sourcePath of paths) assertMatchesCommittedBlob(root, sourceCommit, sourcePath, MAX_PROVENANCE_FILE_BYTES);
  return root;
}

function validateRelease(release: string): void {
  if (release === "candidate") return;
  const match = RELEASE.exec(release);
  if (!match) {
    throw new Error("release must be `candidate` or a full dated release-candidate name");
  }
  const date = new Date(`${release.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== release.slice(0, 10)) {
    throw new Error("release must contain a valid calendar date");
  }
}

function coreWithHash(core: SnapshotCore): SnapshotManifest {
  const corpusSha256 = sha256(canonicalJson(core));
  return Object.freeze({ ...core, corpusSha256 });
}

function assertSnapshotDirectory(snapshotDir: string): string {
  if (!path.isAbsolute(snapshotDir)) throw new Error("Snapshot directory must be an absolute path");
  const resolved = path.resolve(snapshotDir);
  assertNoSymlinkPath(resolved);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Snapshot must be a real directory");
  return resolved;
}

function expectedSnapshotFiles(manifest: SnapshotManifest): Set<string> {
  return new Set(["index.json", "pages", ...manifest.pages.map((page) => page.filePath)]);
}

function verifySnapshotFileSet(root: string, expected: Set<string>): void {
  const found = new Set<string>();
  const walk = (dir: string, prefix = ""): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Snapshot contains a symlink: ${relative}`);
      if (entry.isDirectory()) {
        found.add(relative);
        walk(fullPath, relative);
      } else if (entry.isFile()) {
        assertRegularSingleLink(fullPath, `Snapshot file ${relative}`);
        found.add(relative);
      } else {
        throw new Error(`Snapshot contains an unsupported filesystem entry: ${relative}`);
      }
    }
  };
  walk(root);
  if (found.size !== expected.size || [...expected].some((name) => !found.has(name))) {
    throw new Error("Snapshot has missing or unexpected files");
  }
}

function parseSnapshotManifest(root: string, expectedCorpusSha256?: string): SnapshotManifest {
  const manifestPath = path.join(root, "index.json");
  assertRegularSingleLink(manifestPath, "Snapshot index");
  const bytes = readBoundedRegularFile(manifestPath, "Snapshot index", MAX_INDEX_BYTES);
  const parsed = parseJson(bytes, "Snapshot index");
  exactKeys(parsed, ["schemaVersion", "release", "sourceCommit", "pages", "corpusSha256"], "Snapshot index");
  if (parsed.schemaVersion !== PUBLIC_DOCS_SCHEMA_VERSION || typeof parsed.release !== "string" ||
      typeof parsed.sourceCommit !== "string" || !FULL_COMMIT.test(parsed.sourceCommit) ||
      typeof parsed.corpusSha256 !== "string" || !SHA256.test(parsed.corpusSha256) || !Array.isArray(parsed.pages)) {
    throw new Error("Snapshot index contains invalid metadata");
  }
  validateRelease(parsed.release);
  if (expectedCorpusSha256 !== undefined && (!SHA256.test(expectedCorpusSha256) || parsed.corpusSha256 !== expectedCorpusSha256)) {
    throw new Error("Snapshot corpus hash does not match the trusted expected hash");
  }
  const pages: SnapshotPage[] = [];
  let corpusBytes = 0;
  for (const [index, item] of parsed.pages.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Snapshot page metadata is invalid");
    const page = item as Record<string, unknown>;
    exactKeys(page, ["id", "sourcePath", "filePath", "title", "route", "sha256", "bytes"], "Snapshot page");
    const expected = PUBLIC_DOCS[index];
    if (!expected || page.id !== expected.id || page.sourcePath !== expected.sourcePath || page.filePath !== expected.filePath ||
        page.title !== expected.title || page.route !== expected.route || typeof page.sha256 !== "string" || !SHA256.test(page.sha256) ||
        !Number.isSafeInteger(page.bytes) || (page.bytes as number) < 0 || (page.bytes as number) > MAX_PUBLIC_DOC_BYTES) {
      throw new Error("Snapshot page does not match the reviewed public allowlist");
    }
    corpusBytes += page.bytes as number;
    pages.push(Object.freeze({
      id: expected.id, sourcePath: expected.sourcePath, filePath: expected.filePath,
      title: expected.title, route: expected.route, sha256: page.sha256, bytes: page.bytes as number,
    }));
  }
  if (pages.length !== PUBLIC_DOCS.length || corpusBytes > MAX_PUBLIC_CORPUS_BYTES) throw new Error("Snapshot has an invalid page count or size");

  const core: SnapshotCore = Object.freeze({
    schemaVersion: PUBLIC_DOCS_SCHEMA_VERSION,
    release: parsed.release,
    sourceCommit: parsed.sourceCommit,
    pages: Object.freeze(pages),
  });
  const manifest = coreWithHash(core);
  if (manifest.corpusSha256 !== parsed.corpusSha256) throw new Error("Snapshot corpus hash is invalid");
  if (!Buffer.from(bytes).equals(jsonBytes(manifest))) throw new Error("Snapshot index is not in canonical format");
  return manifest;
}

/** Export exact allowlisted source bytes into a new directory outside the repository. */
export function exportPublicCorpus(options: ExportPublicCorpusOptions): PublicDocsIdentity {
  validateRelease(options.release);
  const root = verifySourceCheckout(options.repoRoot, options.sourceCommit);
  const outDir = assertAbsoluteOutsideRoot(options.outDir, root, "Snapshot output");
  assertNoSymlinkPath(outDir);
  let totalBytes = 0;
  const pages: SnapshotPage[] = [];
  const contents: Buffer[] = [];

  for (const entry of PUBLIC_DOCS) {
    const sourcePath = path.join(root, entry.sourcePath);
    assertNoSymlinkPath(sourcePath);
    const bytes = assertMatchesCommittedBlob(root, options.sourceCommit, entry.sourcePath, MAX_PUBLIC_DOC_BYTES);
    try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error(`Source ${entry.sourcePath} is not valid UTF-8`); }
    if (bytes.length > MAX_PUBLIC_DOC_BYTES) throw new Error(`Source ${entry.sourcePath} exceeds the public page size limit`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_PUBLIC_CORPUS_BYTES) throw new Error("Public documentation exceeds the corpus size limit");
    contents.push(bytes);
    pages.push(Object.freeze({ ...entry, sha256: sha256(bytes), bytes: bytes.length }));
  }

  const core: SnapshotCore = Object.freeze({
    schemaVersion: PUBLIC_DOCS_SCHEMA_VERSION,
    release: options.release,
    sourceCommit: options.sourceCommit,
    pages: Object.freeze(pages),
  });
  const manifest = coreWithHash(core);
  fs.mkdirSync(outDir, { mode: 0o700 });
  try {
    fs.mkdirSync(path.join(outDir, "pages"), { mode: 0o700 });
    contents.forEach((bytes, index) => {
      const page = pages[index]!;
      fs.writeFileSync(path.join(outDir, page.filePath), bytes, { flag: "wx", mode: 0o444 });
    });
    fs.writeFileSync(path.join(outDir, "index.json"), jsonBytes(manifest), { flag: "wx", mode: 0o444 });
  } catch (error) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw new Error(`Could not finish public corpus snapshot at ${outDir}: ${(error as Error).message}`);
  }
  return Object.freeze({ release: manifest.release, sourceCommit: manifest.sourceCommit, corpusSha256: manifest.corpusSha256 });
}

/** Verify all snapshot bytes and expose only fixed public IDs, never caller-selected paths. */
export function verifyPublicCorpus(snapshotDir: string, expectedCorpusSha256: string): VerifiedPublicDocs {
  if (!SHA256.test(expectedCorpusSha256)) throw new Error("A trusted expected corpus SHA-256 is required");
  const root = assertSnapshotDirectory(snapshotDir);
  const manifest = parseSnapshotManifest(root, expectedCorpusSha256);
  verifySnapshotFileSet(root, expectedSnapshotFiles(manifest));
  const content = new Map<string, string>();
  for (const page of manifest.pages) {
    const fullPath = path.join(root, page.filePath);
    assertRegularSingleLink(fullPath, `Snapshot page ${page.id}`);
    const bytes = readBoundedRegularFile(fullPath, `Snapshot page ${page.id}`, MAX_PUBLIC_DOC_BYTES, page.bytes);
    if (bytes.length !== page.bytes || sha256(bytes) !== page.sha256) throw new Error(`Snapshot page ${page.id} failed integrity verification`);
    try { content.set(page.id, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { throw new Error(`Snapshot page ${page.id} is not valid UTF-8`); }
  }
  const pages = Object.freeze(manifest.pages.map((page) => Object.freeze({ ...page })));
  const reader: VerifiedPublicDocs = {
    release: manifest.release,
    sourceCommit: manifest.sourceCommit,
    corpusSha256: manifest.corpusSha256,
    pages,
    list: () => pages,
    read: (id: string) => {
      if (!knownIds.has(id)) throw new Error("Unknown public documentation page");
      const text = content.get(id);
      if (text === undefined) throw new Error("Public documentation page is unavailable");
      return text;
    },
  };
  return Object.freeze(reader);
}

function parseReleaseManifest(bytes: Buffer, expectedRelease?: string): string {
  const manifest = parseJson(bytes, "Release manifest");
  if (typeof manifest.release !== "string") throw new Error("Release manifest has no full release-candidate name");
  validateRelease(manifest.release);
  if (manifest.release === "candidate") throw new Error("Release manifest cannot use a candidate label");
  if (expectedRelease && manifest.release !== expectedRelease) throw new Error("Release manifest does not match the expected release");
  return manifest.release;
}

function assertNewOutputFile(outputPath: string): string {
  if (!path.isAbsolute(outputPath)) throw new Error("Receipt output must be an absolute path");
  const resolved = path.resolve(outputPath);
  assertNoSymlinkPath(path.dirname(resolved));
  try {
    fs.lstatSync(resolved);
    throw new Error("Receipt output already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolved;
}

/** Bind a verified corpus to the exact finalized release-manifest bytes; this does not attest website publication. */
export function createPublicDocsPublicationReceipt(options: PublicationReceiptOptions): PublicDocsPublicationReceipt {
  if (!path.isAbsolute(options.releaseManifestPath)) throw new Error("Release manifest path must be absolute");
  assertNoSymlinkPath(options.releaseManifestPath);
  const corpus = verifyPublicCorpus(options.snapshotDir, options.expectedCorpusSha256);
  if (corpus.release === "candidate") throw new Error("A candidate corpus cannot be bound to a release manifest");
  assertRegularSingleLink(options.releaseManifestPath, "Release manifest");
  const releaseManifestBytes = readBoundedRegularFile(options.releaseManifestPath, "Release manifest", MAX_RELEASE_MANIFEST_BYTES);
  const release = parseReleaseManifest(releaseManifestBytes, corpus.release);
  const receipt: PublicDocsPublicationReceipt = Object.freeze({
    schemaVersion: PUBLIC_DOCS_SCHEMA_VERSION,
    type: "lares-public-docs-release-binding",
    release,
    sourceCommit: corpus.sourceCommit,
    corpusSha256: corpus.corpusSha256,
    releaseManifestSha256: sha256(releaseManifestBytes),
  });
  const outputPath = assertNewOutputFile(options.outputPath);
  fs.writeFileSync(outputPath, jsonBytes(receipt), { flag: "wx", mode: 0o444 });
  return receipt;
}

/** Verify a receipt against caller-trusted release/corpus identity and current manifest bytes. */
export function verifyPublicDocsPublicationReceipt(options: VerifyPublicationReceiptOptions): PublicDocsPublicationReceipt {
  if (!path.isAbsolute(options.receiptPath) || !path.isAbsolute(options.releaseManifestPath)) throw new Error("Receipt and release manifest paths must be absolute");
  assertNoSymlinkPath(options.releaseManifestPath);
  validateRelease(options.expected.release);
  if (!FULL_COMMIT.test(options.expected.sourceCommit) || !SHA256.test(options.expected.corpusSha256)) {
    throw new Error("Expected public-docs identity is invalid");
  }
  const receiptPath = path.resolve(options.receiptPath);
  assertNoSymlinkPath(receiptPath);
  assertRegularSingleLink(receiptPath, "Publication receipt");
  const bytes = readBoundedRegularFile(receiptPath, "Publication receipt", MAX_RECEIPT_BYTES);
  const parsed = parseJson(bytes, "Publication receipt");
  exactKeys(parsed, ["schemaVersion", "type", "release", "sourceCommit", "corpusSha256", "releaseManifestSha256"], "Publication receipt");
  if (parsed.schemaVersion !== PUBLIC_DOCS_SCHEMA_VERSION || parsed.type !== "lares-public-docs-release-binding" ||
      typeof parsed.release !== "string" || typeof parsed.sourceCommit !== "string" || !FULL_COMMIT.test(parsed.sourceCommit) ||
      typeof parsed.corpusSha256 !== "string" || !SHA256.test(parsed.corpusSha256) || typeof parsed.releaseManifestSha256 !== "string" || !SHA256.test(parsed.releaseManifestSha256)) {
    throw new Error("Publication receipt is malformed or noncanonical");
  }
  validateRelease(parsed.release);
  if (parsed.release === "candidate") throw new Error("Publication receipt cannot use a candidate label");
  const canonicalReceipt = {
    schemaVersion: PUBLIC_DOCS_SCHEMA_VERSION,
    type: "lares-public-docs-release-binding" as const,
    release: parsed.release,
    sourceCommit: parsed.sourceCommit,
    corpusSha256: parsed.corpusSha256,
    releaseManifestSha256: parsed.releaseManifestSha256,
  };
  if (!Buffer.from(bytes).equals(jsonBytes(canonicalReceipt))) throw new Error("Publication receipt is malformed or noncanonical");
  if (parsed.release !== options.expected.release || parsed.sourceCommit !== options.expected.sourceCommit || parsed.corpusSha256 !== options.expected.corpusSha256) {
    throw new Error("Publication receipt does not match the trusted public-docs identity");
  }
  assertRegularSingleLink(options.releaseManifestPath, "Release manifest");
  const releaseManifestBytes = readBoundedRegularFile(options.releaseManifestPath, "Release manifest", MAX_RELEASE_MANIFEST_BYTES);
  parseReleaseManifest(releaseManifestBytes, parsed.release);
  if (sha256(releaseManifestBytes) !== parsed.releaseManifestSha256) throw new Error("Release manifest bytes do not match the publication receipt");
  return Object.freeze(canonicalReceipt);
}
