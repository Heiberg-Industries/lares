/**
 * ORB-286 — the note a door adds for content that can't reach the model.
 *
 * Measured 2026-09-14: a Telegram voice note and a video each got no reply at all (eve's parser
 * knows only photo/document, so they arrived empty and the door dropped them), and a Slack audio
 * clip reached Saga as "an empty message". Raw update shapes below follow the Bot API's field
 * names (shaped, not recorded).
 */
import { describe, it, expect } from "vitest";

import { OFFICE_MEDIA_TYPES } from "../src/attachment-hydration.js";
import { slackUnreadableNote, telegramUnreadableNote } from "../src/unreadable-content.js";

const POLICY = { allowedMediaTypes: ["image/*", "application/pdf", "text/*", ...OFFICE_MEDIA_TYPES], maxBytes: 10 * 1024 * 1024 };
const tg = (raw: Record<string, unknown>, attachments: Array<Record<string, unknown>> = []) => ({
  raw,
  attachments: attachments as Array<{ kind: string; fileName?: string; mediaType?: string; size?: number }>,
});

describe("telegramUnreadableNote", () => {
  it("names a voice note and says it can't be listened to", () => {
    expect(telegramUnreadableNote(tg({ voice: { file_id: "V", duration: 3, mime_type: "audio/ogg" } }), POLICY)).toMatch(
      /a voice note \(3 s\), which you cannot listen to yet/,
    );
  });

  it("names a video, a round video, a sticker and a GIF", () => {
    expect(telegramUnreadableNote(tg({ video: { file_id: "W" } }), POLICY)).toMatch(/a video/);
    expect(telegramUnreadableNote(tg({ video_note: { file_id: "N" } }), POLICY)).toMatch(/round video/);
    expect(telegramUnreadableNote(tg({ sticker: { emoji: "👍" } }), POLICY)).toMatch(/sticker \(👍\)/);
    const gif = tg({ animation: { file_id: "G" }, document: { file_id: "G" } }, [{ kind: "document", fileName: "cat.gif.mp4", mediaType: "video/mp4" }]);
    const note = telegramUnreadableNote(gif, POLICY) ?? "";
    expect(note).toMatch(/a GIF/);
    expect(note).not.toMatch(/cat\.gif\.mp4/); // the GIF's document twin is not named twice
  });

  it("passes a shared contact's name and number through", () => {
    expect(telegramUnreadableNote(tg({ contact: { first_name: "Kari", last_name: "N", phone_number: "+4712345678" } }), POLICY)).toMatch(
      /contact card: Kari N, \+4712345678/,
    );
  });

  it("includes a location, unless the door consumes locations itself", () => {
    const m = tg({ location: { latitude: 59.91, longitude: 10.75 } });
    expect(telegramUnreadableNote(m, POLICY)).toMatch(/59\.91, 10\.75/);
    expect(telegramUnreadableNote(m, POLICY, { includeLocation: false })).toBeNull();
  });

  it("names a file the policy drops: wrong type, or too large", () => {
    expect(telegramUnreadableNote(tg({}, [{ kind: "document", fileName: "a.zip", mediaType: "application/zip", size: 10 }]), POLICY)).toMatch(
      /"a\.zip" \(application\/zip\), a format you cannot read/,
    );
    expect(telegramUnreadableNote(tg({}, [{ kind: "document", fileName: "scan.pdf", mediaType: "application/pdf", size: 27_000_000 }]), POLICY)).toMatch(
      /"scan\.pdf" \(25\.7 MB\), larger than the 10\.0 MB/,
    );
  });

  it("says nothing for what does reach the model: a photo, a PDF, a Word file, plain text", () => {
    expect(telegramUnreadableNote(tg({ photo: [] }, [{ kind: "photo", mediaType: "image/jpeg", size: 100 }]), POLICY)).toBeNull();
    expect(telegramUnreadableNote(tg({}, [{ kind: "document", fileName: "r.pdf", mediaType: "application/pdf", size: 100 }]), POLICY)).toBeNull();
    expect(telegramUnreadableNote(tg({}, [{ kind: "document", fileName: "c.docx", mediaType: OFFICE_MEDIA_TYPES[0], size: 100 }]), POLICY)).toBeNull();
    expect(telegramUnreadableNote(tg({ text: "hei" }), POLICY)).toBeNull();
  });
});

describe("slackUnreadableNote", () => {
  it("names an audio clip and a video", () => {
    expect(slackUnreadableNote([{ type: "audio", name: "audio_message.webm", mimeType: "audio/webm" }])).toMatch(
      /an audio clip "audio_message\.webm", which you cannot listen to yet/,
    );
    expect(slackUnreadableNote([{ type: "video", name: "clip.mp4" }])).toMatch(/a video "clip\.mp4"/);
  });

  it("says nothing for images and files, or no attachments", () => {
    expect(slackUnreadableNote([{ type: "image", name: "p.jpg" }, { type: "file", name: "r.pdf" }])).toBeNull();
    expect(slackUnreadableNote(undefined)).toBeNull();
  });
});
