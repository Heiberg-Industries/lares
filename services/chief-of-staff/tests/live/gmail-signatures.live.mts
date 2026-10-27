/**
 * Read-only evidence probe for Gmail's configured signature and its rendered appearance.
 *
 * The owner selects exactly one configured send-as address, one Gmail draft ID and one
 * owner-sent message ID. The script uses the existing Gmail account selection and OAuth setup,
 * then reads only those three resources through the Gmail SDK. It never searches or lists a
 * mailbox, and never writes to Gmail.
 *
 * Run later, by hand, inside the chief-of-staff environment with its existing Gmail session:
 *
 *   PROBE_ACCOUNT=<mailbox> \
 *   PROBE_SEND_AS_EMAIL=<send-as-address> \
 *   PROBE_DRAFT_ID=<one-agent-draft-id> \
 *   PROBE_SENT_MESSAGE_ID=<one-owner-sent-message-id> \
 *   tsx gmail-signatures.live.mts
 *
 * Output contains only counts, element names and CSS property names. It omits account and
 * message identifiers, headers, signature text, profile fields, URLs and HTML. See
 * gmail-signatures-probe.md for limitations and how to interpret the result.
 */
import { google } from "googleapis";
import { buildOAuth2Client } from "@lares/agent-kit/google-auth";
import { __setTestGmailApiFactory, googleClients } from "../../lib/google.js";
import { fileURLToPath } from "node:url";

type SignatureReader = Pick<Awaited<ReturnType<ReturnType<typeof googleClients>["gmail"]>>, "getSignature">;
type GmailApi = ReturnType<typeof google.gmail>;

type HtmlShape = { tags: Record<string, number>; styleProperties: string[] };
const SAFE_TAGS = new Set([
  "a", "b", "blockquote", "body", "br", "caption", "center", "cite", "code", "dd", "div", "dl", "dt",
  "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "html", "i", "img", "li", "ol",
  "p", "pre", "s", "small", "span", "strong", "style", "sub", "sup", "table", "tbody", "td", "th",
  "thead", "tr", "u", "ul",
]);
const SAFE_STYLE_PROPERTIES = new Set([
  "background-color", "border", "border-bottom", "border-color", "border-left", "border-right", "border-top",
  "color", "display", "font-family", "font-size", "font-style", "font-weight", "line-height", "margin",
  "margin-bottom", "margin-left", "margin-right", "margin-top", "padding", "padding-bottom", "padding-left",
  "padding-right", "padding-top", "text-align", "text-decoration", "vertical-align", "white-space",
]);

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "=" && /^[\da-f]{2}$/i.test(value.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (value[i] === "=" && value[i + 1] === "\r" && value[i + 2] === "\n") {
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodePart(body: string, encoding: string): string {
  if (encoding.trim().toLowerCase() === "base64") {
    return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
  }
  if (encoding.trim().toLowerCase() === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

function extractHtml(raw: string): string {
  const split = raw.search(/\r?\n\r?\n/);
  if (split < 0) return "";
  const headers = raw.slice(0, split);
  const body = raw.slice(split).replace(/^\r?\n\r?\n/, "");
  const boundary = headers.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  if (boundary) {
    const chunks = body.split(`--${boundary}`).slice(1).map((part) => part.replace(/^\r?\n/, ""));
    for (const chunk of chunks) {
      if (/content-type\s*:\s*text\/html\b/i.test(chunk)) {
        const html = extractHtml(chunk);
        if (html) return html;
      }
    }
    return "";
  }
  if (!/content-type\s*:\s*text\/html\b/i.test(headers)) return "";
  const encoding = headers.match(/content-transfer-encoding\s*:\s*([^\r\n]+)/i)?.[1] ?? "";
  return decodePart(body, encoding);
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

type MessagePart = { mimeType?: string | null; body?: { data?: string | null } | null; parts?: MessagePart[] | null };

function findHtmlPart(part: MessagePart | null | undefined): string {
  if (!part) return "";
  if (part.mimeType?.toLowerCase() === "text/html" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const html = findHtmlPart(child);
    if (html) return html;
  }
  return "";
}

function shape(html: string): HtmlShape {
  const tags: Record<string, number> = {};
  const properties = new Set<string>();
  for (const match of html.matchAll(/<\s*([a-z][\w:-]*)\b([^>]*)>/gi)) {
    const tag = match[1]!.toLowerCase();
    if (!SAFE_TAGS.has(tag)) continue;
    tags[tag] = (tags[tag] ?? 0) + 1;
    const style = match[2]!.match(/\bstyle\s*=\s*(["'])(.*?)\1/i)?.[2];
    for (const declaration of style?.split(";") ?? []) {
      const property = declaration.split(":", 1)[0]?.trim().toLowerCase();
      if (property && SAFE_STYLE_PROPERTIES.has(property)) properties.add(property);
    }
  }
  return { tags: Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b))), styleProperties: [...properties].sort() };
}

function tagSequence(html: string): string[] {
  return [...html.matchAll(/<\s*([a-z][\w:-]*)\b/gi)]
    .map((match) => match[1]!.toLowerCase())
    .filter((tag) => SAFE_TAGS.has(tag));
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  return haystack.some((_, start) => needle.every((tag, offset) => haystack[start + offset] === tag));
}

function safeCompare(signatureHtml: string, draftRaw: string, sentRaw: string) {
  const draftHtml = extractHtml(draftRaw);
  const sentHtml = extractHtml(sentRaw);
  const signatureShape = shape(signatureHtml);
  const draftShape = shape(draftHtml);
  const sentShape = shape(sentHtml);
  const signatureTags = tagSequence(signatureHtml);
  return {
    configuredSignature: { htmlPresent: signatureHtml.length > 0, shape: signatureShape },
    draft: {
      htmlPresent: draftHtml.length > 0,
      shape: draftShape,
      containsConfiguredSignatureTagSequence: containsSequence(tagSequence(draftHtml), signatureTags),
    },
    ownerSentMessage: {
      htmlPresent: sentHtml.length > 0,
      shape: sentShape,
      containsConfiguredSignatureTagSequence: containsSequence(tagSequence(sentHtml), signatureTags),
    },
    shapeMatches: {
      configuredSignatureEqualsDraft: JSON.stringify(signatureShape) === JSON.stringify(draftShape),
      configuredSignatureEqualsSentMessage: JSON.stringify(signatureShape) === JSON.stringify(sentShape),
    },
  };
}

export async function runProbe(
  gmail: SignatureReader,
  api: GmailApi,
  selected: { sendAsEmail: string; draftId: string; sentMessageId: string },
) {
  const [signature, draft, sent] = await Promise.all([
    gmail.getSignature(selected.sendAsEmail),
    api.users.drafts.get({ userId: "me", id: selected.draftId, format: "raw" }),
    api.users.messages.get({ userId: "me", id: selected.sentMessageId, format: "full" }),
  ]);
  const draftRaw = draft.data.message?.raw ? decodeBase64Url(draft.data.message.raw) : "";
  const sentHtml = findHtmlPart(sent.data.payload);
  const sentRaw = sentHtml ? `Content-Type: text/html\r\n\r\n${sentHtml}` : "";
  return safeCompare(signature, draftRaw, sentRaw);
}

async function main(): Promise<void> {
  const account = process.env["PROBE_ACCOUNT"];
  const sendAsEmail = process.env["PROBE_SEND_AS_EMAIL"];
  const draftId = process.env["PROBE_DRAFT_ID"];
  const sentMessageId = process.env["PROBE_SENT_MESSAGE_ID"];
  if (!sendAsEmail || !draftId || !sentMessageId) {
    throw new Error("Select one send-as address, draft ID and sent-message ID");
  }
  let api: GmailApi | undefined;
  try {
    __setTestGmailApiFactory((cfg, refreshToken) => {
      api = google.gmail({ version: "v1", auth: buildOAuth2Client(cfg, refreshToken) });
      return api;
    });
    const gmail = await googleClients().gmail(account);
    __setTestGmailApiFactory(undefined);
    if (!api) throw new Error("Gmail client unavailable");
    const evidence = await runProbe(gmail, api, { sendAsEmail, draftId, sentMessageId });
    console.log(JSON.stringify(evidence, null, 2));
    console.log("Limit: send-as defaults, other aliases and People profile fields are not exposed by this probe.");
    console.log("Limit: signature tag-sequence presence is structural evidence, not proof of a semantic signature boundary.");
  } finally {
    __setTestGmailApiFactory(undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    console.error("Gmail signature probe unavailable; no resource identifiers or provider details were printed.");
    process.exitCode = 1;
  });
}
