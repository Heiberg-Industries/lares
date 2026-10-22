import fs from "node:fs";
import { constants } from "node:fs";
import { PUBLIC_DOCS, type PublicDocId, type PublicDocsIdentity, verifyPublicCorpus, type VerifiedPublicDocs } from "./public-docs.js";

const IMAGE_ROOT = "/app/public-docs";
const SNAPSHOT_DIR = `${IMAGE_ROOT}/snapshot`;
const IDENTITY_FILE = `${IMAGE_ROOT}/identity.json`;
const MAX_IDENTITY_BYTES = 8_000;
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FULL_RELEASE = /^\d{4}-\d{2}-\d{2}-rc\.\d+$/;

let verified: VerifiedPublicDocs | undefined;

function validRelease(release: string): boolean {
  if (release === "candidate") return true;
  if (!FULL_RELEASE.test(release)) return false;
  const date = new Date(`${release.slice(0, 10)}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === release.slice(0, 10);
}

function assertNoSymlinkPath(absolutePath: string): void {
  const components = absolutePath.split("/").filter(Boolean);
  let current = "";
  for (const component of components) {
    current += `/${component}`;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Public docs image files are unavailable");
  }
}

function readIdentity(): PublicDocsIdentity {
  assertNoSymlinkPath(IMAGE_ROOT);
  assertNoSymlinkPath(IDENTITY_FILE);
  const fd = fs.openSync(IDENTITY_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_IDENTITY_BYTES)) {
      throw new Error("Public docs image identity is invalid");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("Public docs image identity is incomplete");
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.nlink !== after.nlink ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Public docs image identity changed while reading");
    }
    if (bytes.length > MAX_IDENTITY_BYTES) throw new Error("Public docs image identity is too large");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error("Public docs image identity is not valid UTF-8"); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new Error("Public docs image identity is not valid JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Public docs image identity is invalid");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(",") !== "corpusSha256,release,sourceCommit" ||
        typeof record.release !== "string" || !validRelease(record.release) ||
        typeof record.sourceCommit !== "string" || !FULL_COMMIT.test(record.sourceCommit) ||
        typeof record.corpusSha256 !== "string" || !SHA256.test(record.corpusSha256)) {
      throw new Error("Public docs image identity is invalid");
    }
    const identity = { release: record.release, sourceCommit: record.sourceCommit, corpusSha256: record.corpusSha256 };
    if (`${JSON.stringify(identity, null, 2)}\n` !== text) throw new Error("Public docs image identity is not canonical");
    return Object.freeze(identity);
  } finally {
    fs.closeSync(fd);
  }
}

function loadVerified(): VerifiedPublicDocs {
  if (verified) return verified;
  const identity = readIdentity();
  const docs = verifyPublicCorpus(SNAPSHOT_DIR, identity.corpusSha256);
  if (docs.release !== identity.release || docs.sourceCommit !== identity.sourceCommit ||
      docs.corpusSha256 !== identity.corpusSha256) {
    throw new Error("Public docs image identity does not match its snapshot");
  }
  verified = docs;
  return docs;
}

export interface BakedPublicDoc {
  readonly id: PublicDocId;
  readonly title: string;
  readonly sourceCommit: string;
  readonly release: string;
  readonly corpusSha256: string;
  readonly markdown: string;
}

/** Read one reviewed page from the fixed, image-baked corpus. Caller input is only a stable ID. */
export function readBakedPublicDoc(id: PublicDocId): BakedPublicDoc {
  const page = PUBLIC_DOCS.find((candidate) => candidate.id === id);
  if (!page) throw new Error("Unknown public documentation page");
  const docs = loadVerified();
  return Object.freeze({
    id,
    title: page.title,
    release: docs.release,
    sourceCommit: docs.sourceCommit,
    corpusSha256: docs.corpusSha256,
    markdown: docs.read(id),
  });
}

/** The index is small and contains stable IDs only; full page bodies are loaded one at a time. */
export function publicDocsIndex(): string {
  return PUBLIC_DOCS.map((page) => `- ${page.id}: ${page.title} (${page.route})`).join("\n");
}
