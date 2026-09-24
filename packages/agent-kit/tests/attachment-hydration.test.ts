/**
 * ORB-286 — what the model sees for a staged file eve does not inline.
 *
 * Measured 2026-09-14 before this module: a .txt, .md, .docx and .xlsx each reached Saga as a bare
 * `/workspace/attachments/<hash>/<name>` path she could not open, and a HEIC photo ended the
 * session. The Office fixtures below are built in-test as minimal OOXML packages (shaped, not
 * recorded): the same parts Word/Excel/PowerPoint write, with one code word each.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";

import {
  DOCX,
  MAX_ATTACHMENT_TEXT_CHARS,
  PPTX,
  XLSX,
  extractAttachmentText,
  hydrateSandboxRef,
  installAttachmentHydration,
} from "../src/attachment-hydration.js";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [name, body] of Object.entries(files)) z.file(name, body);
  return z.generateAsync({ type: "uint8array" });
}

const docx = () =>
  zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>The code word in this Word file is CEDAR-1187.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph &amp; more.</w:t></w:r></w:p></w:body></w:document>`,
  });

const xlsx = () =>
  zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "xl/sharedStrings.xml": `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>code word</t></si><si><t>BIRCH-5543</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Budget</t></is></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c></row></sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>second sheet</t></is></c></row></sheetData></worksheet>`,
  });

const pptx = () =>
  zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "ppt/slides/slide2.xml": `${XML}<p:sld xmlns:p="p" xmlns:a="a"><p:txBody><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:txBody></p:sld>`,
    "ppt/slides/slide1.xml": `${XML}<p:sld xmlns:p="p" xmlns:a="a"><p:txBody><a:p><a:r><a:t>The code word is </a:t></a:r><a:r><a:t>ASPEN-7702.</a:t></a:r></a:p></p:txBody></p:sld>`,
  });

const ref = (name: string, mediaType: string, size = 1000) => ({ mediaType, path: `/workspace/attachments/abc123/${name}`, size });
const bytes = (s: string) => new TextEncoder().encode(s);

describe("extractAttachmentText", () => {
  it("reads plain text, markdown and csv as text", async () => {
    expect(await extractAttachmentText(bytes("LARCH-6639"), "text/plain")).toBe("LARCH-6639");
    expect(await extractAttachmentText(bytes("# **SPRUCE-8816**"), "text/markdown; charset=utf-8")).toContain("SPRUCE-8816");
    expect(await extractAttachmentText(bytes("item,code\nprobe,ROWAN-3094"), "text/csv")).toContain("ROWAN-3094");
  });

  it("extracts a Word document's text", async () => {
    const text = await extractAttachmentText(await docx(), DOCX);
    expect(text).toContain("CEDAR-1187");
    expect(text).toContain("Second paragraph & more.");
  });

  it("extracts an Excel workbook's cells, shared and inline strings, sheet by sheet", async () => {
    const text = (await extractAttachmentText(await xlsx(), XLSX)) ?? "";
    expect(text).toContain("code word\tBIRCH-5543");
    expect(text).toContain("Budget\t42");
    expect(text.indexOf("Sheet 1")).toBeLessThan(text.indexOf("Sheet 2"));
  });

  it("extracts a PowerPoint deck's text in slide order", async () => {
    const text = (await extractAttachmentText(await pptx(), PPTX)) ?? "";
    expect(text).toContain("Slide 1:\nThe code word is ASPEN-7702.");
    expect(text.indexOf("ASPEN-7702")).toBeLessThan(text.indexOf("Second slide"));
  });

  it("returns null for a format it cannot read", async () => {
    expect(await extractAttachmentText(bytes("PK"), "application/zip")).toBeNull();
  });
});

describe("hydrateSandboxRef", () => {
  it("hands the model a text file's content, naming the file", async () => {
    const part = await hydrateSandboxRef(ref("notes.txt", "text/plain"), async () => bytes("LARCH-6639"));
    expect(part.type).toBe("text");
    expect(part.text).toContain("notes.txt");
    expect(part.text).toContain("LARCH-6639");
    expect(part.text).not.toContain("/workspace/attachments");
  });

  it("hands the model a Word file's text", async () => {
    const d = await docx();
    const part = await hydrateSandboxRef(ref("contract.docx", DOCX), async () => d);
    expect(part.text).toContain("CEDAR-1187");
  });

  it("says plainly that a HEIC photo can't be viewed — without reading it", async () => {
    let read = false;
    const part = await hydrateSandboxRef(ref("IMG_0001.HEIC", "image/heic"), async () => ((read = true), bytes("x")));
    expect(part.text).toMatch(/IMG_0001\.HEIC.*cannot be viewed/);
    expect(read).toBe(false);
  });

  it("says plainly that an image over 3 MB is too large to view", async () => {
    const part = await hydrateSandboxRef(ref("IMG_0002.JPG", "image/jpeg", 4_200_000), async () => null);
    expect(part.text).toMatch(/IMG_0002\.JPG.*larger than/);
  });

  it("says plainly that a PDF over 20 MB is too large", async () => {
    const part = await hydrateSandboxRef(ref("scan.pdf", "application/pdf", 27_000_000), async () => null);
    expect(part.text).toMatch(/scan\.pdf.*larger than/);
  });

  it("says plainly that an unreadable format can't be read, naming it", async () => {
    const part = await hydrateSandboxRef(ref("archive.zip", "application/zip"), async () => bytes("PK"));
    expect(part.text).toMatch(/archive\.zip \(application\/zip\).*cannot be read/);
  });

  it("says a damaged Office file couldn't be read instead of throwing", async () => {
    const part = await hydrateSandboxRef(ref("broken.docx", DOCX), async () => bytes("not a zip"));
    expect(part.text).toMatch(/broken\.docx.*could not be read/);
  });

  it("says a file lost in a restart must be sent again", async () => {
    const part = await hydrateSandboxRef(ref("notes.txt", "text/plain"), async () => null);
    expect(part.text).toMatch(/no longer available/);
  });

  it("caps a long document and says it did", async () => {
    const long = "a".repeat(MAX_ATTACHMENT_TEXT_CHARS + 10);
    const part = await hydrateSandboxRef(ref("long.txt", "text/plain"), async () => bytes(long));
    expect(part.text.length).toBeLessThan(MAX_ATTACHMENT_TEXT_CHARS + 500);
    expect(part.text).toMatch(/only the first 60,000 of 60,010 characters/);
  });

  it("installAttachmentHydration points eve's patched hook at it", () => {
    const saved = globalThis.__laresHydrateSandboxRef;
    try {
      globalThis.__laresHydrateSandboxRef = undefined;
      installAttachmentHydration();
      expect(globalThis.__laresHydrateSandboxRef).toBe(hydrateSandboxRef);
    } finally {
      globalThis.__laresHydrateSandboxRef = saved;
    }
  });
});
