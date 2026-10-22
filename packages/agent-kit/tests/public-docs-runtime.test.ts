import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  identity: "",
  missing: false,
  links: 1n,
  read: vi.fn(),
  open: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fstatSync = () => ({
    dev: 1n, ino: 2n, nlink: fake.links, size: BigInt(Buffer.byteLength(fake.identity)),
    mtimeNs: 3n, ctimeNs: 4n, isFile: () => true,
  });
  const lstatSync = (filePath: string) => {
    if (fake.missing && filePath.endsWith("identity.json")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isSymbolicLink: () => false };
  };
  const openSync = (filePath: string) => { fake.open(filePath); return 9; };
  const readSync = (_fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
    fake.read();
    return Buffer.from(fake.identity, "utf8").copy(buffer, offset, position, position + length);
  };
  const closeSync = () => undefined;
  const mockedDefault = Object.assign(Object.create(actual), { fstatSync, lstatSync, openSync, readSync, closeSync });
  return { ...actual, default: mockedDefault, fstatSync, lstatSync, openSync, readSync, closeSync };
});

vi.mock("../src/public-docs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/public-docs.js")>();
  return { ...actual, verifyPublicCorpus: fake.verify };
});

const expectedIdentity = {
  release: "candidate",
  sourceCommit: "a".repeat(40),
  corpusSha256: "b".repeat(64),
};
const canonicalIdentity = () => `${JSON.stringify(expectedIdentity, null, 2)}\n`;

beforeEach(() => {
  fake.identity = canonicalIdentity();
  fake.missing = false;
  fake.links = 1n;
  fake.read.mockClear();
  fake.open.mockClear();
  fake.verify.mockReset().mockReturnValue({
    ...expectedIdentity,
    pages: [],
    list: () => [],
    read: (id: string) => `PUBLIC_BODY:${id}`,
  });
});
afterEach(() => vi.resetModules());

it("reads one exact page only after the bounded fixed image identity matches the verified snapshot", async () => {
  const runtime = await import("../src/public-docs-runtime.js");
  const index = runtime.publicDocsIndex();
  expect(index.length).toBeLessThan(4_000);
  expect(index).toContain("install-with-agent");
  expect(index).not.toContain("PUBLIC_BODY");
  expect(runtime.readBakedPublicDoc("using-the-console")).toMatchObject({
    id: "using-the-console", release: "candidate", sourceCommit: expectedIdentity.sourceCommit,
    corpusSha256: expectedIdentity.corpusSha256, markdown: "PUBLIC_BODY:using-the-console",
  });
  expect(fake.verify).toHaveBeenCalledOnce();
  expect(fake.verify).toHaveBeenCalledWith("/app/public-docs/snapshot", expectedIdentity.corpusSha256);
  expect(fake.open).toHaveBeenCalledWith("/app/public-docs/identity.json");
});

it("rejects unknown IDs before touching the baked files", async () => {
  const runtime = await import("../src/public-docs-runtime.js");
  expect(() => runtime.readBakedPublicDoc("../../etc/passwd" as never)).toThrow("Unknown public documentation page");
  expect(fake.open).not.toHaveBeenCalled();
  expect(fake.verify).not.toHaveBeenCalled();
});

it("refuses absent, oversized, linked, malformed, and non-matching image identity data", async () => {
  const runtime = await import("../src/public-docs-runtime.js");
  fake.missing = true;
  expect(() => runtime.readBakedPublicDoc("install")).toThrow("missing");
  expect(fake.open).not.toHaveBeenCalled();

  await vi.resetModules();
  fake.missing = false;
  fake.identity = "x".repeat(8_001);
  let current = await import("../src/public-docs-runtime.js");
  expect(() => current.readBakedPublicDoc("install")).toThrow("invalid");
  expect(fake.read).not.toHaveBeenCalled();

  await vi.resetModules();
  fake.identity = canonicalIdentity();
  fake.links = 2n;
  current = await import("../src/public-docs-runtime.js");
  expect(() => current.readBakedPublicDoc("install")).toThrow("invalid");
  expect(fake.read).not.toHaveBeenCalled();

  await vi.resetModules();
  fake.links = 1n;
  fake.identity = "not-json";
  current = await import("../src/public-docs-runtime.js");
  expect(() => current.readBakedPublicDoc("install")).toThrow("valid JSON");

  await vi.resetModules();
  fake.identity = canonicalIdentity();
  fake.verify.mockReturnValue({ ...expectedIdentity, sourceCommit: "c".repeat(40), read: () => "" });
  current = await import("../src/public-docs-runtime.js");
  expect(() => current.readBakedPublicDoc("install")).toThrow("does not match");
});
