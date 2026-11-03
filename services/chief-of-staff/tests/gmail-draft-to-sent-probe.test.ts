import { describe, expect, it, vi } from "vitest";
import type { google } from "googleapis";
import { buildMime, create, inspect, parseArgs, probeBody, MARKER_HEADER } from "./live/gmail-draft-to-sent.live.mts";

type Api = ReturnType<typeof google.gmail>;

const own = "owner@example.com";
const marker = "0123456789abcdef01234567";
const ids = { draft: "r-draft-id", message: "draft-msg-id", thread: "thread-id-1", since: "5000" };
const args = { mode: "inspect" as const, ...ids, marker };

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const notFound = () => Object.assign(new Error("gone"), { code: 404 });

function sentMessage(over: { marker?: string | null; body?: string } = {}) {
  const headers = [{ name: "Message-ID", value: "<abc@mail.example.com>" }];
  if (over.marker !== null) headers.push({ name: MARKER_HEADER, value: over.marker ?? marker });
  return {
    id: "sent-msg-id",
    threadId: ids.thread,
    internalDate: "2000",
    labelIds: ["SENT"],
    payload: {
      mimeType: "multipart/alternative",
      headers,
      parts: [{ mimeType: "text/plain", body: { data: b64(over.body ?? probeBody(marker).replace("\n", "\r\n")) } }],
    },
  };
}

function fakeApi(o: { draftExists?: boolean; sent?: ReturnType<typeof sentMessage> | null; history?: unknown[] | "404" } = {}): Api {
  const sent = o.sent === undefined ? sentMessage() : o.sent;
  return {
    users: {
      drafts: {
        get: vi.fn(async () => {
          if (!o.draftExists) throw notFound();
          return { data: { message: { id: ids.message, payload: { headers: [{ name: "Message-ID", value: "<abc@mail.example.com>" }] } } } };
        }),
        create: vi.fn(async () => ({ data: { id: ids.draft, message: { id: ids.message, threadId: ids.thread } } })),
      },
      messages: {
        get: vi.fn(async () => {
          if (!o.draftExists) throw notFound();
          return { data: {} };
        }),
      },
      threads: { get: vi.fn(async () => ({ data: { messages: sent ? [{ id: "other", labelIds: ["INBOX"], internalDate: "1" }, sent] : [] } })) },
      history: {
        list: vi.fn(async () => {
          if (o.history === "404") throw notFound();
          return {
            data: {
              history: o.history ?? [
                { messagesDeleted: [{ message: { id: ids.message } }] },
                { messagesAdded: [{ message: { id: "sent-msg-id" } }] },
                { labelsAdded: [{}] },
              ],
            },
          };
        }),
      },
      getProfile: vi.fn(async () => ({ data: { emailAddress: own, historyId: "5000" } })),
    },
  } as unknown as Api;
}

describe("gmail draft-to-sent probe", () => {
  it("builds a mime message to and from the own address with the marker header", () => {
    const mime = buildMime(own, "Lares draft probe abc", marker);
    expect(mime).toContain(`From: ${own}\r\n`);
    expect(mime).toContain(`To: ${own}\r\n`);
    expect(mime).toContain(`${MARKER_HEADER}: ${marker}\r\n`);
    expect(mime).toContain("Subject: Lares draft probe abc\r\n");
    expect(mime).toContain(probeBody(marker).replace("\n", "\r\n"));
  });

  it("create writes exactly one draft and prints the values to copy", async () => {
    const api = fakeApi();
    const out = await create(api);
    expect(api.users.drafts.create).toHaveBeenCalledTimes(1);
    expect(out).toContain(ids.draft);
    expect(out).toContain("since:   5000");
    expect(out).toContain("press Send without editing it");
    const call = vi.mocked(api.users.drafts.create).mock.calls[0]![0] as unknown as { requestBody: { message: { raw: string } } };
    const mime = Buffer.from(call.requestBody.message.raw, "base64url").toString();
    expect(mime).toMatch(/X-Lares-Draft-Marker: [0-9a-f]{16,}/);
  });

  it("reports a surviving marker, same thread, new id, history and matching body", async () => {
    const e = await inspect(fakeApi(), args);
    expect(e).toMatchObject({
      draftStillExists: false,
      draftMessageStillExists: false,
      sentFound: true,
      sentIdEqualsDraftMessageId: false,
      sameThread: true,
      markerHeaderSurvived: true,
      messageIdHeaderPresent: true,
      messageIdEqualsDraftMessageIdHeader: null,
      bodyMatches: true,
    });
    expect(e.history).toEqual({
      available: true,
      recordTypes: ["labelsAdded", "messagesAdded", "messagesDeleted"],
      draftMessageSeenDeleted: true,
      sentMessageSeenAdded: true,
    });
  });

  it("says plainly when nothing is sent yet", async () => {
    const e = await inspect(fakeApi({ sent: null, history: [] }), args);
    expect(e.sentFound).toBe(false);
    expect(e.note).toContain("not sent yet");
  });

  it("detects a lost marker", async () => {
    const e = await inspect(fakeApi({ sent: sentMessage({ marker: null }) }), args);
    expect(e.markerHeaderSurvived).toBe(false);
  });

  it("detects a draft that is still there and an edited body", async () => {
    const e = await inspect(fakeApi({ draftExists: true, sent: sentMessage({ body: "changed" }) }), args);
    expect(e.draftStillExists).toBe(true);
    expect(e.draftMessageStillExists).toBe(true);
    expect(e.messageIdEqualsDraftMessageIdHeader).toBe(true);
    expect(e.bodyMatches).toBe(false);
  });

  it("copes with history that is no longer available", async () => {
    const e = await inspect(fakeApi({ history: "404" }), args);
    expect(e.history.available).toBe(false);
  });

  it("parses arguments", () => {
    expect(parseArgs(["create"])).toEqual({ mode: "create" });
    expect(parseArgs(["inspect", "--draft", "a", "--message", "b", "--thread", "c", "--marker", marker, "--since", "9"])).toEqual({
      mode: "inspect", draft: "a", message: "b", thread: "c", marker, since: "9",
    });
    expect(() => parseArgs(["inspect", "--draft", "a"])).toThrow();
    expect(() => parseArgs(["inspect", "--draft", "a", "--message", "b", "--thread", "c", "--marker", "zz", "--since", "9"])).toThrow();
    expect(() => parseArgs(["nope"])).toThrow();
  });

  it("output contains no ids, addresses, subjects or body text", async () => {
    const sent = sentMessage();
    (sent.payload.headers as { name: string; value: string }[]).push({ name: "Subject", value: "Secret subject line" }, { name: "To", value: own });
    const out = JSON.stringify(await inspect(fakeApi({ sent }), args));
    for (const s of [ids.draft, ids.message, ids.thread, ids.since, "sent-msg-id", marker, own, "Secret subject", "mail.example.com", "test draft"]) {
      expect(out).not.toContain(s);
    }
  });
});
