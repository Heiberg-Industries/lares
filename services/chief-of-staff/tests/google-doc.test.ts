/**
 * ORB-286 batch 6 — Google Docs/Sheets/Slides/Drive links through the Drive API.
 * The Drive client is a stand-in shaped like googleapis' `drive.files` (shaped, not recorded);
 * the real response shapes are checked by tests/live/google-doc.live.mts.
 */
import { describe, it, expect } from "vitest";

import { GoogleDocUnavailableError, googleDocFromUrl, readGoogleDoc } from "../lib/google-doc.js";
import type { DriveApi } from "../lib/google-drive.js";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

describe("googleDocFromUrl", () => {
  it("reads the id and kind from the link shapes Google hands out", () => {
    expect(googleDocFromUrl(`https://docs.google.com/document/d/${ID}/edit?usp=sharing`)).toEqual({ id: ID, kind: "document" });
    expect(googleDocFromUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toEqual({ id: ID, kind: "spreadsheets" });
    expect(googleDocFromUrl(`https://docs.google.com/presentation/d/${ID}/edit`)).toEqual({ id: ID, kind: "presentation" });
    expect(googleDocFromUrl(`https://docs.google.com/document/u/1/d/${ID}/edit`)).toEqual({ id: ID, kind: "document" });
    expect(googleDocFromUrl(`https://drive.google.com/file/d/${ID}/view`)).toEqual({ id: ID, kind: "file" });
    expect(googleDocFromUrl(`https://drive.google.com/open?id=${ID}`)).toEqual({ id: ID, kind: "file" });
  });

  it("is null for anything else", () => {
    expect(googleDocFromUrl("https://docs.google.com/forms/d/e/abc/viewform")).toBeNull();
    expect(googleDocFromUrl(`https://notdocs.google.com.evil.test/document/d/${ID}`)).toBeNull();
    expect(googleDocFromUrl("https://paulgraham.com/greatwork.html")).toBeNull();
  });
});

type Behaviour = { meta?: { name: string; mimeType: string; size?: string }; metaError?: { status: number; message: string }; exported?: string; media?: Uint8Array };

function drive(b: Behaviour): DriveApi {
  const files = {
    async get(params: { alt?: string }) {
      if (b.metaError) throw Object.assign(new Error(b.metaError.message), { response: { status: b.metaError.status } });
      if (params.alt === "media") return { data: b.media!.buffer };
      return { data: b.meta };
    },
    async export() {
      return { data: b.exported };
    },
  };
  return { files } as unknown as DriveApi;
}

const url = `https://docs.google.com/document/d/${ID}/edit`;

describe("readGoogleDoc", () => {
  it("exports a Google Doc as text, titled with its name", async () => {
    const out = await readGoogleDoc(url, {
      apis: async () => [{ account: "owner@owner.example", api: drive({ meta: { name: "Folkepuls plan", mimeType: "application/vnd.google-apps.document" }, exported: "Owner: Kjetil\n" }) }],
    });
    expect(out).toEqual({ title: "Folkepuls plan", text: "Owner: Kjetil" });
  });

  it("says a spreadsheet export is the first sheet only", async () => {
    const out = await readGoogleDoc(`https://docs.google.com/spreadsheets/d/${ID}/edit`, {
      apis: async () => [{ account: "a", api: drive({ meta: { name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }, exported: "item,code\nprobe,BIRCH-5543" }) }],
    });
    expect(out.text).toMatch(/only the first sheet/);
    expect(out.text).toContain("BIRCH-5543");
  });

  it("downloads a text file stored in Drive", async () => {
    const out = await readGoogleDoc(`https://drive.google.com/file/d/${ID}/view`, {
      apis: async () => [{ account: "a", api: drive({ meta: { name: "notes.txt", mimeType: "text/plain", size: "10" }, media: new TextEncoder().encode("LARCH-6639") }) }],
    });
    expect(out.text).toBe("LARCH-6639");
  });

  it("tries the next account when the first can't see the file", async () => {
    const out = await readGoogleDoc(url, {
      apis: async () => [
        { account: "owner@owner.example", api: drive({ metaError: { status: 404, message: "File not found" } }) },
        { account: "owner@project.example", api: drive({ meta: { name: "Zero7 doc", mimeType: "application/vnd.google-apps.document" }, exported: "hi" }) },
      ],
    });
    expect(out.title).toBe("Zero7 doc");
  });

  it("says plainly that Drive access hasn't been granted yet (insufficient scope)", async () => {
    const err = await readGoogleDoc(url, {
      apis: async () => [{ account: "a", api: drive({ metaError: { status: 403, message: "Request had insufficient authentication scopes." } }) }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleDocUnavailableError);
    expect((err as Error).message).toMatch(/not yet allowed to read Google Drive/);
  });

  it("says plainly that no connected account can see it, naming the accounts", async () => {
    await expect(
      readGoogleDoc(url, { apis: async () => [{ account: "owner@owner.example", api: drive({ metaError: { status: 404, message: "File not found" } }) }] }),
    ).rejects.toThrow(/not shared with, the connected Google accounts \(owner@owner\.example\)/);
  });

  it("names a format it can't read instead of pretending", async () => {
    await expect(
      readGoogleDoc(`https://drive.google.com/file/d/${ID}/view`, {
        apis: async () => [{ account: "a", api: drive({ meta: { name: "movie.mp4", mimeType: "video/mp4" } }) }],
      }),
    ).rejects.toThrow(/"movie\.mp4" is a video\/mp4 file/);
  });
});
