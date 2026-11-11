/**
 * Conformance: the INSTALLED eve carries the attachment hunk from patches/eve.patch, and it does
 * what the hunk is for.
 *
 * eve 1.0 shows the model a label for every staged file (`Attached file <path> (<type>)`) and
 * adds the bytes only for the image types and PDFs every provider reads. For every other file the
 * label is all the model gets: a path no agent can open. The patch changes one branch of
 * `hydrateMessageContent` (eve/dist/src/harness/attachment-staging.js): a file eve does not
 * inline is handed to `globalThis.__laresHydrateSandboxRef(ref, read)`, and the text that
 * returns takes the label's place. A missing hook, a hook that throws, and a hook that returns no
 * text all leave eve's label, so the patch can only ever add to what eve does.
 *
 * Which files eve inlines is eve's own rule now (`inlinesSandboxRefAsBytes`); nothing here
 * restates it. These tests call the installed `hydrateSandboxAttachments` inside a real eve
 * context, with a stand-in for the sandbox that serves the staged bytes, and with the real hook
 * from `../src/attachment-hydration.ts`.
 *
 * An eve bump that drops the hunk fails here, not in a chat.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

import { DOCX, hydrateSandboxRef, installAttachmentHydration } from "../src/attachment-hydration.js";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../src/untrusted-text.js";

const require = createRequire(import.meta.url);

function eveRoot(): string {
  let dir = path.dirname(require.resolve("eve"));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "package.json")) && path.basename(dir) === "eve") return dir;
    dir = path.dirname(dir);
  }
  throw new Error("could not locate the installed eve package root from require.resolve('eve')");
}

// eve INTERNALS, imported by file path because the package's exports map does not expose them.
// If an eve upgrade moves these files, this suite failing to load is the signal to re-derive the
// patch against the new version.
const internal = (file: string): Promise<any> => import(pathToFileURL(path.join(eveRoot(), "dist/src", file)).href);

type Part = { type: string; text?: string; data?: unknown; mediaType?: string; filename?: string };
type Message = { role: string; content: Part[] | string };

let hydrateSandboxAttachments: (messages: Message[]) => Promise<Message[]>;
let encodeSandboxRef: (ref: { path: string; size: number; mediaType: string; width?: number; height?: number }) => URL;
let ContextContainer: new () => { set(key: unknown, value: unknown): unknown };
let contextStorage: { run<T>(ctx: unknown, fn: () => T): T };
let SandboxKey: unknown;
let SessionIdKey: unknown;

beforeAll(async () => {
  ({ hydrateSandboxAttachments } = await internal("harness/attachment-staging.js"));
  ({ encodeSandboxRef } = await internal("internal/attachments/sandbox-refs.js"));
  ({ ContextContainer, contextStorage } = await internal("context/container.js"));
  ({ SandboxKey, SessionIdKey } = await internal("context/keys.js"));
});

const saved = globalThis.__laresHydrateSandboxRef;
afterEach(() => {
  globalThis.__laresHydrateSandboxRef = saved;
});

const bytes = (s: string) => new TextEncoder().encode(s);

/** A staged file, as eve's staging leaves it: under a directory named for its content hash. */
function staged(name: string, mediaType: string, content: Uint8Array, extra: { width?: number; height?: number } = {}) {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const ref = { mediaType, path: `/workspace/.eve/attachments/${hash}/${name}`, size: content.byteLength, ...extra };
  const part: Part = { data: encodeSandboxRef(ref), filename: ref.path, mediaType, type: "file" };
  return { content, label: `Attached file ${ref.path} (${mediaType})`, part, ref };
}

let sessions = 0;
/**
 * Runs eve's hydration over one user message, inside an eve context whose sandbox holds `files`.
 * A fresh session id each time: eve keeps the bytes it has read per session.
 */
async function hydrate(parts: Part[], files: ReturnType<typeof staged>[], opts: { sandbox?: boolean } = {}): Promise<Part[]> {
  const ctx = new ContextContainer();
  const disk = new Map(files.map((f) => [f.ref.path, f.content]));
  if (opts.sandbox !== false) {
    ctx.set(SandboxKey, { open: async () => ({ readBinaryFile: async ({ path: p }: { path: string }) => disk.get(p) ?? null }) });
  }
  ctx.set(SessionIdKey, `session-${(sessions += 1)}`);
  const out = await contextStorage.run(ctx, () => hydrateSandboxAttachments([{ content: parts, role: "user" }]));
  return out[0]!.content as Part[];
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
async function docx(sentence: string): Promise<Uint8Array> {
  const z = new JSZip();
  z.file("[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file("word/document.xml", `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${sentence}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: "uint8array" });
}

describe("eve attachment-staging patch", () => {
  it("the installed eve carries the hunk", () => {
    const staging = readFileSync(path.join(eveRoot(), "dist/src/harness/attachment-staging.js"), "utf8");
    expect(staging).toContain("if(!inlinesSandboxRefAsBytes(n))return laresHydrateSandboxRef(n,t,r);");
    expect(staging).toContain("async function laresHydrateSandboxRef(e,t,n){let r=globalThis.__laresHydrateSandboxRef;");
  });

  it("a .txt, a .md and a .docx reach the model as their text, not as a path", async () => {
    installAttachmentHydration();
    const files = [
      staged("notes.txt", "text/plain", bytes("The code word is LARCHWOOD.")),
      staged("plan.md", "text/markdown", bytes("# Plan\n\nThe code word is **SPRUCEGUM**.")),
      staged("contract.docx", DOCX, await docx("The code word in this Word file is CEDARBARK.")),
    ];
    const out = await hydrate([{ text: "three files", type: "text" }, ...files.map((f) => f.part)], files);

    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ text: "three files", type: "text" });
    for (const [i, word] of [[1, "LARCHWOOD"], [2, "SPRUCEGUM"], [3, "CEDARBARK"]] as const) {
      expect(Object.keys(out[i]!).sort()).toEqual(["text", "type"]);
      expect(out[i]!.type).toBe("text");
      expect(out[i]!.text).toContain(word);
      expect(out[i]!.text).not.toContain("/workspace/");
    }
    expect(out[1]!.text).toContain("notes.txt");
    // The document's words arrive quoted, as somebody else's.
    expect(out[1]!.text).toContain(UNTRUSTED_OPEN);
    expect(out[1]!.text!.trimEnd().endsWith(UNTRUSTED_CLOSE)).toBe(true);
  });

  it("hands the hook eve's reference and a reader that returns the staged bytes", async () => {
    const file = staged("notes.txt", "text/plain", bytes("LARCHWOOD"));
    const seen: unknown[] = [];
    globalThis.__laresHydrateSandboxRef = async (ref, read) => {
      seen.push(ref, new TextDecoder().decode((await read()) ?? undefined));
      return { text: "FROM THE HOOK", type: "text" };
    };
    const out = await hydrate([file.part], [file]);
    expect(seen).toEqual([file.ref, "LARCHWOOD"]);
    expect(out).toEqual([{ text: "FROM THE HOOK", type: "text" }]);
  });

  it("only the hook's text is used: nothing else a hook returns reaches the model", async () => {
    const file = staged("notes.txt", "text/plain", bytes("x"));
    globalThis.__laresHydrateSandboxRef = (async () => ({ data: "AAAA", mediaType: "image/png", text: "the text", type: "file" })) as never;
    expect(await hydrate([file.part], [file])).toEqual([{ text: "the text", type: "text" }]);
  });

  it("without the hook, the file is eve's label", async () => {
    globalThis.__laresHydrateSandboxRef = undefined;
    const file = staged("notes.txt", "text/plain", bytes("x"));
    expect(await hydrate([file.part], [file])).toEqual([{ text: file.label, type: "text" }]);
  });

  it.each([[null], [undefined], ["just a string"], [{ type: "text" }], [{ text: 42, type: "text" }], [{ text: "   ", type: "text" }]])(
    "a hook that returns %j leaves eve's label",
    async (result) => {
      const file = staged("notes.txt", "text/plain", bytes("x"));
      globalThis.__laresHydrateSandboxRef = (async () => result) as never;
      expect(await hydrate([file.part], [file])).toEqual([{ text: file.label, type: "text" }]);
    },
  );

  it("a hook that throws does not break the message: the file is eve's label, the rest is untouched", async () => {
    const file = staged("notes.txt", "text/plain", bytes("x"));
    globalThis.__laresHydrateSandboxRef = async () => {
      throw new Error("hook crashed");
    };
    const out = await hydrate([{ text: "before", type: "text" }, file.part, { text: "after", type: "text" }], [file]);
    expect(out).toEqual([{ text: "before", type: "text" }, { text: file.label, type: "text" }, { text: "after", type: "text" }]);
  });

  it("a file that is gone from the sandbox is a plain sentence, never a path", async () => {
    installAttachmentHydration();
    const file = staged("notes.txt", "text/plain", bytes("LARCHWOOD"));
    const out = await hydrate([file.part], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toMatch(/notes\.txt.*no longer available/);
    expect(out[0]!.text).not.toContain("/workspace/");
  });

  it("a file whose bytes changed since it was staged is not read", async () => {
    installAttachmentHydration();
    const file = staged("notes.txt", "text/plain", bytes("LARCHWOOD"));
    const swapped = { ...file, content: bytes("SWAPPEDTEXT") };
    const out = await hydrate([file.part], [swapped]);
    expect(out[0]!.text).toMatch(/no longer available/);
    expect(out[0]!.text).not.toContain("SWAPPED");
  });

  it("with no sandbox to read from, the file is a plain sentence and the message survives", async () => {
    installAttachmentHydration();
    const file = staged("notes.txt", "text/plain", bytes("LARCHWOOD"));
    const out = await hydrate([file.part, { text: "after", type: "text" }], [file], { sandbox: false });
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toMatch(/notes\.txt.*could not be opened/);
    expect(out[1]).toEqual({ text: "after", type: "text" });
  });

  it("an image within eve's limits is still inlined as bytes, and never reaches the hook", async () => {
    let called = false;
    globalThis.__laresHydrateSandboxRef = async (ref, read) => ((called = true), hydrateSandboxRef(ref, read));
    const png = staged("photo.png", "image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), { height: 600, width: 800 });
    const out = await hydrate([png.part], [png]);

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ text: png.label, type: "text" });
    expect(out[1]!.type).toBe("file");
    expect(out[1]!.mediaType).toBe("image/png");
    expect(Buffer.from(out[1]!.data as Uint8Array).equals(Buffer.from(png.content))).toBe(true);
    expect(called).toBe(false);
  });

  it("an image eve will not inline is a plain sentence from the hook", async () => {
    installAttachmentHydration();
    const heic = staged("IMG_0001.HEIC", "image/heic", bytes("not really heic"));
    const out = await hydrate([heic.part], [heic]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toMatch(/IMG_0001\.HEIC.*cannot be viewed/);
  });

  it("a file a TOOL returned keeps eve's label: the hook covers what a person attached", async () => {
    let called = false;
    globalThis.__laresHydrateSandboxRef = async () => ((called = true), { text: "FROM THE HOOK", type: "text" });
    const file = staged("export.csv", "text/csv", bytes("a,b\n1,2"));
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, { open: async () => ({ readBinaryFile: async () => file.content }) });
    ctx.set(SessionIdKey, "session-tool-output");
    const toolMessage = {
      content: [
        {
          output: { type: "content", value: [{ data: { type: "url", url: file.part.data }, mediaType: "text/csv", type: "file" }] },
          toolCallId: "call_1",
          toolName: "some_tool",
          type: "tool-result",
        },
      ],
      role: "tool",
    };
    const out = await contextStorage.run(ctx, () => hydrateSandboxAttachments([toolMessage as never]));
    const output = (out[0]!.content as unknown as { output: { value: Part[] } }[])[0]!.output;
    expect(output.value).toEqual([{ text: file.label, type: "text" }]);
    expect(called).toBe(false);
  });
});
