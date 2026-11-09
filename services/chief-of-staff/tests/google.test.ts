import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  wrapGmailApi,
  googleClients, listEnrolledMailboxes,
  __setTestGmailApiFactory,
} from "../lib/google.js";
import { GoogleConfigError } from "@lares/agent-kit/google-auth";
import { forgetChosenMailbox, useChosenMailbox, useNoChosenMailbox } from "./helpers/chosen-mailbox.js";

/**
 * The Google stack:
 *   - googleClients() serves only the mailbox the agent's owner chose, and refuses plainly when
 *     none is chosen (the choice itself is covered in agent-mailbox*.test.ts)
 *   - wrapGmailApi marshals the googleapis params (userId/q/maxResults/format/raw/…) exactly,
 *     proven against a stub `google.gmail()`-shaped object — no network, no DB
 *
 * The `decryptSecret` and `readTokenEncKey` suites live in
 * `packages/agent-kit/tests/google-auth.test.ts`; what is specific to this service is the
 * mailbox policy and the capability adapter.
 */

// -----------------------------------------------------------------------------------------
// wrapGmailApi — marshals googleapis params exactly. Stub api only;
// no network, no DB.
// -----------------------------------------------------------------------------------------

interface RecordedCall { method: string; params: unknown }

function stubGmailApi(responses: Partial<{
  list: unknown; get: unknown; send: unknown; createDraft: unknown; sendAs: unknown; threadsGet: unknown;
}> = {}) {
  const calls: RecordedCall[] = [];
  const api = {
    users: {
      messages: {
        list: async (params: unknown) => {
          calls.push({ method: "list", params });
          return responses.list ?? { data: { messages: [] } };
        },
        get: async (params: unknown) => {
          calls.push({ method: "get", params });
          return responses.get ?? { data: {} };
        },
        send: async (params: unknown) => {
          calls.push({ method: "send", params });
          return responses.send ?? { data: { id: "m1", threadId: "t1" } };
        },
      },
      drafts: {
        create: async (params: unknown) => {
          calls.push({ method: "createDraft", params });
          return responses.createDraft ?? { data: { id: "d1", message: { id: "m1", threadId: "t1" } } };
        },
      },
      threads: {
        get: async (params: unknown) => {
          calls.push({ method: "threadsGet", params });
          return responses.threadsGet ?? { data: { messages: [] } };
        },
      },
      settings: {
        sendAs: {
          get: async (params: unknown) => {
            calls.push({ method: "getSignature", params });
            return responses.sendAs ?? { data: { signature: "" } };
          },
        },
      },
    },
  };
  return { api: api as unknown as Parameters<typeof wrapGmailApi>[0], calls };
}

describe("wrapGmailApi", () => {
  it("list: userId 'me', q, maxResults — exactly, no pageToken/threadId leakage", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).list({ q: "in:inbox -from:me", maxResults: 25 });
    expect(calls).toEqual([{ method: "list", params: { userId: "me", q: "in:inbox -from:me", maxResults: 25 } }]);
  });

  it("get: userId 'me', id, format 'full'", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).get("msg123");
    expect(calls).toEqual([{ method: "get", params: { userId: "me", id: "msg123", format: "full" } }]);
  });

  it("send: userId 'me', requestBody { raw, threadId }", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).send("BASE64RAW", "thread1");
    expect(calls).toEqual([{ method: "send", params: { userId: "me", requestBody: { raw: "BASE64RAW", threadId: "thread1" } } }]);
  });

  // — outreach_track used to timestamp a send at TRACK time (a separate, later tool
  // call), so a very fast reply could arrive before that recorded time and never match the
  // reply-detection filter. send() now surfaces a `sentAt` the caller can pass straight
  // through to outreach_track.
  describe("send — sentAt", () => {
    it("uses Gmail's own internalDate when the response includes it", async () => {
      const { api } = stubGmailApi({ send: { data: { id: "m1", threadId: "t1", internalDate: "1755331200000" } } });
      const result = await wrapGmailApi(api).send("BASE64RAW", "thread1");
      expect(result.sentAt).toBe(new Date(1755331200000).toISOString());
    });

    it("falls back to the moment the call resolved when internalDate is absent", async () => {
      const { api } = stubGmailApi({ send: { data: { id: "m1", threadId: "t1" } } });
      const before = Date.now();
      const result = await wrapGmailApi(api).send("BASE64RAW", "thread1");
      const parsed = Date.parse(result.sentAt);
      expect(parsed).toBeGreaterThanOrEqual(before);
      expect(parsed).toBeLessThanOrEqual(Date.now());
    });
  });

  it("createDraft: userId 'me', requestBody { message: { raw, threadId } }", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).createDraft("BASE64RAW", "thread1");
    expect(calls).toEqual([{ method: "createDraft", params: { userId: "me", requestBody: { message: { raw: "BASE64RAW", threadId: "thread1" } } } }]);
  });

  it("getSignature: userId 'me', sendAsEmail", async () => {
    const { api, calls } = stubGmailApi({ sendAs: { data: { signature: "<p>Test Owner</p>" } } });
    const sig = await wrapGmailApi(api).getSignature("owner@owner.example");
    expect(calls).toEqual([{ method: "getSignature", params: { userId: "me", sendAsEmail: "owner@owner.example" } }]);
    expect(sig).toBe("<p>Test Owner</p>");
  });

  // — hasDraftForThread used to be one unpaginated drafts.list(maxResults: 100) page
  // checked for a matching threadId, so dedup silently broke past ~100 total mailbox drafts
  // regardless of relevance. Now scoped to THIS thread via threads.get + a DRAFT label check.
  describe("hasDraftForThread", () => {
    it("true when a message in the thread carries the DRAFT label", async () => {
      const { api, calls } = stubGmailApi({
        threadsGet: { data: { messages: [{ id: "m1", labelIds: ["SENT"] }, { id: "m2", labelIds: ["DRAFT"] }] } },
      });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(true);
      expect(calls).toEqual([{ method: "threadsGet", params: { userId: "me", id: "t1", format: "minimal" } }]);
    });

    it("false when no message in the thread carries the DRAFT label", async () => {
      const { api } = stubGmailApi({
        threadsGet: { data: { messages: [{ id: "m1", labelIds: ["INBOX"] }] } },
      });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(false);
    });

    it("false on a thread with no messages", async () => {
      const { api } = stubGmailApi({ threadsGet: { data: {} } });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(false);
    });

    // The regression this fixes: this exact behavior is INDEPENDENT of how many drafts
    // exist elsewhere in the mailbox — there is no pagination to exhaust, because the call
    // is scoped to the one thread being checked.
    it("is unaffected by how many other drafts exist in the mailbox — no pagination to exceed", async () => {
      const { api } = stubGmailApi({
        threadsGet: { data: { messages: [{ id: "m1", labelIds: ["DRAFT"] }] } },
      });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(true);
    });
  });
});

// -----------------------------------------------------------------------------------------
// googleClients — laziness + GoogleUnenrolledError, against a REAL Postgres. Nothing here
// touches Google: __setTestGmailApiFactory means an "enrolled" test never has to.
// -----------------------------------------------------------------------------------------

describe("googleClients", () => {
  beforeEach(() => { useNoChosenMailbox(); });
  afterEach(() => { forgetChosenMailbox(); vi.unstubAllEnvs(); });

  it("is lazy: constructing the client does no I/O at all", () => {
    expect(() => googleClients()).not.toThrow();
  });

  it("with no mailbox chosen, refuses plainly and lists nothing", async () => {
    await expect(googleClients().gmail()).rejects.toThrow(GoogleConfigError);
    await expect(googleClients().gmail()).rejects.toThrow("No mailbox chosen for this agent; choose one on its Access tab");
    await expect(googleClients().calendar()).rejects.toThrow("No mailbox chosen for this agent; choose one on its Access tab");
    await expect(listEnrolledMailboxes()).resolves.toEqual([]);
  });

  it("never falls back to an environment pin or a stored token when nothing is chosen", async () => {
    vi.stubEnv("GOOGLE_PRINCIPAL_ID", "U_owner"); vi.stubEnv("GMAIL_PRIMARY_EMAIL", "owner@owner.example");
    vi.stubEnv("CALENDAR_PRIMARY_EMAIL", "owner@owner.example"); vi.stubEnv("LARES_EMAIL_PRINCIPAL", "U_owner");
    let built = 0;
    __setTestGmailApiFactory(() => { built++; return {} as never; });
    try {
      await expect(googleClients().gmail("owner@owner.example")).rejects.toThrow(/No mailbox chosen/);
      await expect(listEnrolledMailboxes()).resolves.toEqual([]);
      expect(built).toBe(0);
    } finally { __setTestGmailApiFactory(undefined); }
  });

  it("with a mailbox chosen, serves only that mailbox", async () => {
    const { api } = stubGmailApi({ list: { data: { messages: [{ id: "m1", threadId: "t1" }] } } });
    useChosenMailbox({ mailbox: "owner@owner.example", gmailApi: api });
    await expect(listEnrolledMailboxes()).resolves.toEqual(["owner@owner.example"]);
    await expect((await googleClients().gmail()).search("in:inbox", 25)).resolves.toEqual(["m1"]);
    await expect(googleClients().gmail("other@owner.example")).rejects.toThrow(/owner@owner.example only/);
  });
});
