import { describe, expect, it, vi } from "vitest";
import type { google } from "googleapis";
import { runProbe } from "./live/gmail-signatures.live.mts";

describe("Gmail signature live probe", () => {
  it("reads only the three explicitly selected resources and returns redacted structure", async () => {
    const signature = '<div style="font-family:Arial; --private-email:private@example.invalid"><x-private-name>Private Name<br>private@example.invalid</x-private-name></div>';
    const identifiers = { sendAsEmail: "private@example.invalid", draftId: "draft-private-id", sentMessageId: "sent-private-id" };
    const gmail = { getSignature: vi.fn(async () => signature) };
    const html = `<html><body><div class="gmail_signature">${signature}</div></body></html>`;
    const api = {
      users: {
        drafts: { get: vi.fn(async () => ({ data: { message: { raw: Buffer.from(`MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Draft body</p>${signature}`).toString("base64url") } } })) },
        messages: { get: vi.fn(async () => ({ data: { payload: { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } }] } } })) },
      },
    } as unknown as ReturnType<typeof google.gmail>;

    const evidence = await runProbe(gmail, api, identifiers);
    const serialized = JSON.stringify(evidence);
    expect(gmail.getSignature).toHaveBeenCalledExactlyOnceWith(identifiers.sendAsEmail);
    expect(api.users.drafts.get).toHaveBeenCalledExactlyOnceWith({ userId: "me", id: identifiers.draftId, format: "raw" });
    expect(api.users.messages.get).toHaveBeenCalledExactlyOnceWith({ userId: "me", id: identifiers.sentMessageId, format: "full" });
    expect(evidence.configuredSignature.htmlPresent).toBe(true);
    expect(evidence.configuredSignature.shape.tags).not.toHaveProperty("x-private-name");
    expect(evidence.configuredSignature.shape.styleProperties).not.toContain("--private-email");
    expect(evidence.draft.containsConfiguredSignatureTagSequence).toBe(true);
    expect(evidence.ownerSentMessage.containsConfiguredSignatureTagSequence).toBe(true);
    expect(serialized).not.toContain("Private Name");
    expect(serialized).not.toContain("private@example.invalid");
    expect(serialized).not.toContain(identifiers.draftId);
    expect(serialized).not.toContain(identifiers.sentMessageId);
  });
});
