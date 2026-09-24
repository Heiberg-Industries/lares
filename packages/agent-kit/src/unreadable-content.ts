/**
 * The note a door adds when part of a message cannot reach the model as content (ORB-286).
 *
 * Measured 2026-09-14, eve 0.32:
 *  - Telegram: eve's parser knows only `photo` and `document`. A voice note, audio, video, round
 *    video, sticker, contact or location arrives as an EMPTY message, and the door's gate drops it
 *    — no reply at all.
 *  - Telegram: a document outside the door's upload policy (a GIF arrives as `video/mp4`, a zip, a
 *    file over 10 MB) is dropped before the turn with only a log line. The model gets an empty
 *    message, or answers a caption about a file it never saw.
 *  - Slack: eve drops audio and video clips outright (`toSlackFilePart` returns null).
 *
 * The contract: the agent always says what it received. So the door hands the model one bracketed
 * note through eve's `context`, naming what arrived and why it can't be read. The agent then tells
 * the user in its own voice.
 */

/** The door's upload policy, in eve's `UploadPolicy` shape. */
export interface DoorUploadPolicy {
  allowedMediaTypes: readonly string[];
  maxBytes: number;
}

/** eve's parsed Telegram attachment (`TelegramAttachment`). */
interface TelegramAttachmentLike {
  kind: string;
  fileName?: string;
  mediaType?: string;
  size?: number;
}

/** eve's Slack attachment (`SlackMessage.attachments[]`). */
interface SlackAttachmentLike {
  type: string;
  name?: string;
  mimeType?: string;
}

function mediaTypeAllowed(type: string, policy: DoorUploadPolicy): boolean {
  const t = type.toLowerCase();
  return policy.allowedMediaTypes.some((a) => {
    const p = a.toLowerCase();
    return p === "*" || p === t || (p.endsWith("/*") && t.startsWith(p.slice(0, -1)));
  });
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function wrap(items: string[]): string | null {
  if (items.length === 0) return null;
  return (
    `[The user's message included ${items.join("; ")}. ` +
    `Tell the user plainly what you did not receive, and what they can do instead.]`
  );
}

/**
 * A note for everything in a Telegram message the model will not get as content, or null.
 * `includeLocation: false` for a door that consumes locations itself (Marcel tracks them).
 */
export function telegramUnreadableNote(
  message: { raw: unknown; attachments: readonly TelegramAttachmentLike[] },
  policy: DoorUploadPolicy,
  opts: { includeLocation?: boolean } = {},
): string | null {
  const raw = asRecord(message.raw) ?? {};
  const items: string[] = [];

  const voice = asRecord(raw["voice"]);
  if (voice) {
    const secs = typeof voice["duration"] === "number" ? ` (${voice["duration"]} s)` : "";
    items.push(`a voice note${secs}, which you cannot listen to yet — ask them to type it`);
  }
  const audio = asRecord(raw["audio"]);
  if (audio) items.push(`an audio file${str(audio["file_name"]) ? ` "${str(audio["file_name"])}"` : ""}, which you cannot listen to`);
  if (asRecord(raw["video"])) items.push("a video, which you cannot watch");
  if (asRecord(raw["video_note"])) items.push("a round video message, which you cannot watch");
  const sticker = asRecord(raw["sticker"]);
  if (sticker) items.push(`a sticker${str(sticker["emoji"]) ? ` (${str(sticker["emoji"])})` : ""}`);
  if (asRecord(raw["animation"])) items.push("a GIF, which you cannot view");
  const contact = asRecord(raw["contact"]);
  if (contact) {
    const name = [str(contact["first_name"]), str(contact["last_name"])].filter(Boolean).join(" ");
    items.push(`a shared contact card: ${name || "no name"}, ${str(contact["phone_number"]) ?? "no phone number"}`);
  }
  const location = asRecord(raw["location"]);
  if (location && opts.includeLocation !== false) {
    items.push(`a shared location: ${String(location["latitude"])}, ${String(location["longitude"])}`);
  }

  // Documents the upload policy drops before the turn. A GIF's document twin is already named above.
  for (const a of message.attachments) {
    if (a.kind !== "document" || asRecord(raw["animation"])) continue;
    const type = a.mediaType ?? "application/octet-stream";
    const name = a.fileName ?? "a file";
    if (!mediaTypeAllowed(type, policy)) {
      items.push(`the file "${name}" (${type}), a format you cannot read — they can send it as PDF, Word, Excel, PowerPoint or plain text`);
    } else if (typeof a.size === "number" && a.size > policy.maxBytes) {
      items.push(`the file "${name}" (${mb(a.size)}), larger than the ${mb(policy.maxBytes)} you can receive here`);
    }
  }
  return wrap(items);
}

/** A note for the Slack files eve drops (audio and video clips), or null. */
export function slackUnreadableNote(attachments: readonly SlackAttachmentLike[] | undefined): string | null {
  const items: string[] = [];
  for (const a of attachments ?? []) {
    const name = a.name ? ` "${a.name}"` : "";
    if (a.type === "audio") items.push(`an audio clip${name}, which you cannot listen to yet — ask them to type it`);
    else if (a.type === "video") items.push(`a video${name}, which you cannot watch`);
  }
  return wrap(items);
}
