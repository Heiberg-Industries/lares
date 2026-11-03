/**
 * Hand-run probe: does a Gmail draft keep an identity we can find again after the owner sends it?
 *
 * Google documents that sending a draft deletes it and creates a new message id. This probe
 * tests whether a marker header set on the draft survives a send from Gmail web and from the
 * Gmail phone app, and whether the sent message can be found again through its thread.
 *
 * Run by hand inside the chief-of-staff environment, from services/chief-of-staff/tests/live:
 *
 *   PROBE_ACCOUNT=<mailbox> node --import tsx gmail-draft-to-sent.live.mts create
 *   PROBE_ACCOUNT=<mailbox> node --import tsx gmail-draft-to-sent.live.mts inspect \
 *     --draft <id> --message <id> --thread <id> --marker <hex> --since <historyId>
 *
 * `create` makes exactly one write: one draft addressed to the mailbox's own address. `inspect`
 * is read-only and prints only booleans, counts and record-type names. See
 * gmail-draft-to-sent-probe.md.
 */
import { google } from "googleapis";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildOAuth2Client } from "@lares/agent-kit/google-auth";
import { __setTestGmailApiFactory, googleClients } from "../../lib/google.js";

export type GmailApi = ReturnType<typeof google.gmail>;

export const MARKER_HEADER = "X-Lares-Draft-Marker";

export type Args =
  | { mode: "create" }
  | { mode: "inspect"; draft: string; message: string; thread: string; marker: string; since: string };

export function parseArgs(argv: string[]): Args {
  const [mode, ...rest] = argv;
  if (mode === "create") return { mode };
  if (mode !== "inspect") throw new Error("mode must be create or inspect");
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error("bad arguments");
    values[flag.slice(2)] = value;
  }
  const { draft, message, thread, marker, since } = values;
  if (!draft || !message || !thread || !marker || !since) throw new Error("missing arguments");
  if (!/^[0-9a-f]{16,}$/i.test(marker)) throw new Error("bad marker");
  return { mode, draft, message, thread, marker, since };
}

/** The two body lines, derived from the marker so inspect can rebuild them after the draft is gone. */
export function probeBody(marker: string): string {
  return `This is a test draft from the Lares draft probe. Send it unchanged.\nProbe reference ${marker}.`;
}

export function newMarker(): string {
  return randomBytes(12).toString("hex");
}

export function buildMime(own: string, subject: string, marker: string): string {
  return [
    `From: ${own}`,
    `To: ${own}`,
    `Subject: ${subject}`,
    `${MARKER_HEADER}: ${marker}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    probeBody(marker).replace(/\n/g, "\r\n"),
    "",
  ].join("\r\n");
}

type Header = { name?: string | null; value?: string | null };
type Part = { mimeType?: string | null; headers?: Header[] | null; body?: { data?: string | null } | null; parts?: Part[] | null };
type Message = { id?: string | null; threadId?: string | null; internalDate?: string | null; labelIds?: string[] | null; payload?: Part | null };

function header(message: Message | undefined | null, name: string): string | undefined {
  return message?.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function plainText(part: Part | null | undefined): string {
  if (!part) return "";
  if (part.mimeType?.toLowerCase() === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const text = plainText(child);
    if (text) return text;
  }
  return "";
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  return e?.code === 404 || e?.status === 404 || e?.response?.status === 404;
}

export type InspectArgs = Extract<Args, { mode: "inspect" }>;

export type Evidence = {
  draftStillExists: boolean;
  draftMessageStillExists: boolean;
  sentFound: boolean;
  sentIdEqualsDraftMessageId: boolean | null;
  sameThread: boolean | null;
  markerHeaderSurvived: boolean | null;
  messageIdHeaderPresent: boolean | null;
  messageIdEqualsDraftMessageIdHeader: boolean | null;
  bodyMatches: boolean | null;
  history: {
    available: boolean;
    recordTypes: string[];
    draftMessageSeenDeleted: boolean;
    sentMessageSeenAdded: boolean;
  };
  note?: string;
};

export async function inspect(api: GmailApi, args: InspectArgs): Promise<Evidence> {
  let draftMessage: Message | undefined;
  let draftStillExists = true;
  try {
    const d = await api.users.drafts.get({ userId: "me", id: args.draft, format: "full" });
    draftMessage = d.data.message as Message | undefined;
  } catch (err) {
    if (!isNotFound(err)) throw err;
    draftStillExists = false;
  }
  let draftMessageStillExists = true;
  try {
    await api.users.messages.get({ userId: "me", id: args.message, format: "minimal" });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    draftMessageStillExists = false;
  }

  let thread: { messages?: Message[] | null } = {};
  try {
    thread = (await api.users.threads.get({ userId: "me", id: args.thread, format: "full" })).data as typeof thread;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  const sentList = (thread.messages ?? []).filter((m) => m.labelIds?.includes("SENT"));
  sentList.sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0));
  const sent = sentList[0];

  let recordTypes = new Set<string>();
  let historyAvailable = true;
  let draftSeenDeleted = false;
  let sentSeenAdded = false;
  try {
    let pageToken: string | undefined;
    do {
      const res = await api.users.history.list({ userId: "me", startHistoryId: args.since, pageToken });
      for (const rec of res.data.history ?? []) {
        if (rec.messagesAdded?.length) recordTypes.add("messagesAdded");
        if (rec.messagesDeleted?.length) recordTypes.add("messagesDeleted");
        if (rec.labelsAdded?.length) recordTypes.add("labelsAdded");
        if (rec.labelsRemoved?.length) recordTypes.add("labelsRemoved");
        if (rec.messagesDeleted?.some((m) => m.message?.id === args.message)) draftSeenDeleted = true;
        if (sent?.id && rec.messagesAdded?.some((m) => m.message?.id === sent.id)) sentSeenAdded = true;
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    historyAvailable = false;
    recordTypes = new Set();
  }
  const history = {
    available: historyAvailable,
    recordTypes: [...recordTypes].sort(),
    draftMessageSeenDeleted: draftSeenDeleted,
    sentMessageSeenAdded: sentSeenAdded,
  };

  if (!sent) {
    return {
      draftStillExists,
      draftMessageStillExists,
      sentFound: false,
      sentIdEqualsDraftMessageId: null,
      sameThread: null,
      markerHeaderSurvived: null,
      messageIdHeaderPresent: null,
      messageIdEqualsDraftMessageIdHeader: null,
      bodyMatches: null,
      history,
      note: "not sent yet, or not visible yet; wait a minute and run inspect again",
    };
  }
  const sentMessageId = header(sent, "Message-ID");
  const draftMessageIdHeader = header(draftMessage, "Message-ID");
  return {
    draftStillExists,
    draftMessageStillExists,
    sentFound: true,
    sentIdEqualsDraftMessageId: sent.id === args.message,
    sameThread: sent.threadId === args.thread,
    markerHeaderSurvived: header(sent, MARKER_HEADER)?.trim() === args.marker,
    messageIdHeaderPresent: Boolean(sentMessageId),
    messageIdEqualsDraftMessageIdHeader: draftMessageIdHeader ? sentMessageId === draftMessageIdHeader : null,
    bodyMatches: squash(plainText(sent.payload)) === squash(probeBody(args.marker)),
    history,
  };
}

export async function create(api: GmailApi): Promise<string> {
  const profile = await api.users.getProfile({ userId: "me" });
  const own = profile.data.emailAddress;
  const since = profile.data.historyId;
  if (!own || !since) throw new Error("profile incomplete");
  const marker = newMarker();
  const subject = `Lares draft probe ${randomBytes(3).toString("hex")}`;
  const res = await api.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw: Buffer.from(buildMime(own, subject, marker)).toString("base64url") } },
  });
  const draft = res.data.id;
  const message = res.data.message?.id;
  const thread = res.data.message?.threadId;
  if (!draft || !message || !thread) throw new Error("draft incomplete");
  return [
    `draft:   ${draft}`,
    `message: ${message}`,
    `thread:  ${thread}`,
    `marker:  ${marker}`,
    `since:   ${since}`,
    "",
    "Now open this draft in Gmail (web or phone) and press Send without editing it, then run inspect with these values:",
    `inspect --draft ${draft} --message ${message} --thread ${thread} --marker ${marker} --since ${since}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const account = process.env["PROBE_ACCOUNT"];
  let api: GmailApi | undefined;
  try {
    __setTestGmailApiFactory((cfg, refreshToken) => {
      api = google.gmail({ version: "v1", auth: buildOAuth2Client(cfg, refreshToken) });
      return api;
    });
    await googleClients().gmail(account);
    __setTestGmailApiFactory(undefined);
    if (!api) throw new Error("Gmail client unavailable");
    if (args.mode === "create") {
      console.log(await create(api));
    } else {
      const evidence = await inspect(api, args);
      console.log(JSON.stringify(evidence, null, 2));
      if (evidence.note) console.log(evidence.note);
    }
  } finally {
    __setTestGmailApiFactory(undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    console.error("Gmail draft probe unavailable; no resource identifiers or provider details were printed.");
    process.exitCode = 1;
  });
}
