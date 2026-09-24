import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

/**
 * ORB-156 follow-up-note wiring: `meeting_followup_send`'s `execute()` writes a Twenty CRM
 * note per recipient after a successful send, via `twenty_note.ts`'s extracted
 * `createTwentyNote` core — not the gated `twenty_note` tool itself (that would demand a
 * second 👍 per recipient; see the tool's own header comment).
 *
 * Gmail is stubbed the same way tests/meeting-followup-approval.test.ts stubs it — these
 * tests exist to prove the CRM-note side effect, not to re-prove gmail.send's own request
 * shape (tests/tools-gmail.test.ts owns that) or `followupApproval`'s policy (tests/
 * meeting-followup-approval.test.ts owns that). Twenty is a REAL local HTTP server (matching
 * tests/tools-twenty.test.ts's style), not a fetch stub, so the actual REST calls are proven.
 *
 * Security-review follow-up (ORB-156): a recipient not in Twenty must get NO note (not an
 * unlinked one carrying their full email body forever), and a genuine Twenty failure must
 * still surface — as a per-recipient log AND a best-effort signal — without ever touching the
 * send result. `emitSignal` is mocked so the "signal fired" half of that is provable without
 * standing up a real signal-spine server.
 */
const sendMock = vi.fn(async () => ({ gmailMessageId: "m1", gmailThreadId: "t1", sentAt: "2026-08-24T00:00:00.000Z" }));
const getSignatureMock = vi.fn(async () => "");
vi.mock("../lib/google.js", () => ({
  googleClients: () => ({ gmail: async () => ({ send: sendMock, getSignature: getSignatureMock }) }),
}));

const emitSignalMock = vi.fn(async () => {});
vi.mock("../lib/signal-emit.js", () => ({ emitSignal: (...args: unknown[]) => emitSignalMock(...args) }));

import meetingFollowupSend from "../catalogue/meeting_followup_send.js";

const RECIPIENTS = ["sam@example.com", "taylor@example.com"];

const INPUT = {
  notionPageId: "page1",
  seriesKey: "s1",
  to: RECIPIENTS,
  subject: "Follow-up: sync",
  bodyText: "Notes from the sync — action items attached.",
  meetingTitle: "Weekly sync",
  meetingWhen: "2026-08-24T09:00:00.000Z",
  from: "owner@owner.example",
};

// eve's own documented shape for a schedule-dispatched (autonomous) turn — matches
// tests/meeting-followup-approval.test.ts's APP_PRINCIPAL exactly.
const APP_PRINCIPAL = { authenticator: "app", principalId: "eve:app", principalType: "runtime" };

function ctxWithAuth(current: unknown, initiator: unknown = current) {
  return { session: { id: "s1", auth: { current, initiator } } } as never;
}

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

let server: Server | undefined;
let keyDir: string;
let requests: Recorded[];

/**
 * A stub Twenty that records every request. `resolvable` names which recipient emails the
 * person-lookup GET should find a match for (defaults to all of RECIPIENTS) — everyone else's
 * lookup returns zero people, exactly like a real, unresolved recipient. `down: true` makes
 * every request fail with a 503, the shape a genuinely unreachable Twenty takes.
 */
function listen(opts?: { resolvable?: readonly string[]; down?: boolean }): Promise<void> {
  const resolvable = new Set(opts?.resolvable ?? RECIPIENTS);
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body: unknown;
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
        }
        const url = req.url ?? "";
        const recorded: Recorded = { method: req.method ?? "", url, body };
        requests.push(recorded);

        if (opts?.down) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "down" }));
          return;
        }

        if (req.method === "GET" && url.includes("/people?")) {
          const decoded = decodeURIComponent(url);
          const match = [...resolvable].find((email) => decoded.includes(email));
          const people = match ? [{ id: `person_${match}` }] : [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { people } }));
          return;
        }
        if (req.method === "POST" && url === "/rest/notes") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { note: { id: `note_${requests.length}` } } }));
          return;
        }
        // /rest/noteTargets and anything else — harmless success.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: {} }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server!.address() as AddressInfo).port;
      process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

beforeEach(() => {
  requests = [];
  sendMock.mockClear();
  getSignatureMock.mockClear();
  getSignatureMock.mockResolvedValue("");
  emitSignalMock.mockClear();
  keyDir = mkdtempSync(join(tmpdir(), "twenty-followup-key-"));
  writeFileSync(join(keyDir, "twenty-key"), "test-api-key\n");
  process.env["TWENTY_KEY_FILE"] = join(keyDir, "twenty-key");
});

afterEach(async () => {
  delete process.env["TWENTY_BASE_URL"];
  delete process.env["TWENTY_KEY_FILE"];
  rmSync(keyDir, { recursive: true, force: true });
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("meeting_followup_send — CRM touchpoint note (ORB-156)", () => {
  it("passes the mailbox signature to Gmail without putting it in the CRM body", async () => {
    await listen();
    getSignatureMock.mockResolvedValue("<p>Bendik</p>");

    await meetingFollowupSend.execute(INPUT, ctxWithAuth(APP_PRINCIPAL));

    expect(getSignatureMock).toHaveBeenCalledWith(INPUT.from);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      bodyText: INPUT.bodyText,
      signatureHtml: "<p>Bendik</p>",
    }));
  });

  it("sends without a signature when Gmail cannot fetch it", async () => {
    await listen();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getSignatureMock.mockRejectedValue(new Error("signature unavailable"));

    await meetingFollowupSend.execute(INPUT, ctxWithAuth(APP_PRINCIPAL));

    expect(sendMock).toHaveBeenCalledWith(expect.not.objectContaining({ signatureHtml: expect.anything() }));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Gmail signature unavailable"), expect.any(Error));
    errorSpy.mockRestore();
  });

  it("writes one LINKED note per recipient, each carrying the meeting title and the sent body", async () => {
    await listen(); // both recipients resolve

    const result = await meetingFollowupSend.execute(INPUT, ctxWithAuth(APP_PRINCIPAL));

    expect(result).toEqual({ gmailMessageId: "m1", gmailThreadId: "t1", sentAt: "2026-08-24T00:00:00.000Z" });

    const noteCreates = requests.filter((r) => r.method === "POST" && r.url === "/rest/notes");
    expect(noteCreates).toHaveLength(RECIPIENTS.length);
    for (const create of noteCreates) {
      const body = create.body as { title: string; bodyV2: { markdown: string } };
      expect(body.title).toBe("Meeting follow-up sent — Weekly sync");
      expect(body.bodyV2.markdown).toContain("Weekly sync");
      expect(body.bodyV2.markdown).toContain(INPUT.subject);
      expect(body.bodyV2.markdown).toContain(INPUT.bodyText);
    }

    // Each note is linked via noteTargets — proves resolution happened, not just creation.
    const links = requests.filter((r) => r.method === "POST" && r.url === "/rest/noteTargets");
    expect(links).toHaveLength(RECIPIENTS.length);

    // Each note is targeted at its OWN recipient's address, not fanned out to everyone.
    const emailLookups = requests.filter((r) => r.method === "GET" && r.url.includes("/people?"));
    const lookedUp = emailLookups.map((r) => decodeURIComponent(r.url));
    for (const recipient of RECIPIENTS) {
      expect(lookedUp.some((u) => u.includes(recipient))).toBe(true);
    }
  });

  it("a recipient not in Twenty gets NO note — logged, not created unlinked (security review fix)", async () => {
    // Only the first recipient resolves; the second is a stranger to the CRM.
    await listen({ resolvable: [RECIPIENTS[0]!] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await meetingFollowupSend.execute(INPUT, ctxWithAuth(APP_PRINCIPAL));

    expect(result).toEqual({ gmailMessageId: "m1", gmailThreadId: "t1", sentAt: "2026-08-24T00:00:00.000Z" });

    const noteCreates = requests.filter((r) => r.method === "POST" && r.url === "/rest/notes");
    expect(noteCreates).toHaveLength(1); // only the resolved recipient

    const skipLogs = logSpy.mock.calls.filter((c) => String(c[0]).includes("no CRM note"));
    expect(skipLogs).toHaveLength(1);
    expect(String(skipLogs[0]![0])).toContain(RECIPIENTS[1]);
    expect(String(skipLogs[0]![0])).toContain(INPUT.notionPageId);

    logSpy.mockRestore();
  });

  it("a Twenty failure does not make the send look failed — it logs AND emits a signal", async () => {
    await listen({ down: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await meetingFollowupSend.execute(INPUT, ctxWithAuth(APP_PRINCIPAL));

    expect(result).toEqual({ gmailMessageId: "m1", gmailThreadId: "t1", sentAt: "2026-08-24T00:00:00.000Z" });
    expect(sendMock).toHaveBeenCalledTimes(1);

    // One error log per failed recipient note, each naming the page id.
    const noteFailureLogs = errSpy.mock.calls.filter((c) => String(c[0]).includes("CRM note FAILED"));
    expect(noteFailureLogs).toHaveLength(RECIPIENTS.length);
    for (const call of noteFailureLogs) {
      expect(String(call[0])).toContain(INPUT.notionPageId);
    }

    // The autonomous path has no card and no Slack line — the signal is the only trace
    // besides container logs. Best-effort: emitSignal is mocked to succeed here, and the
    // send result above already proves a failing signal spine cannot touch it regardless.
    expect(emitSignalMock).toHaveBeenCalledTimes(RECIPIENTS.length);
    for (const call of emitSignalMock.mock.calls) {
      expect(call[2]).toContain(INPUT.notionPageId);
    }

    errSpy.mockRestore();
  });

  it("an autonomous send (no human approver) also writes the notes", async () => {
    await listen();

    // No human ever clicked anything here — the app principal is the ONLY dispatcher, exactly
    // the shape eve's schedule dispatcher stamps for an opted-in autonomous send.
    await meetingFollowupSend.execute(INPUT, ctxWithAuth(APP_PRINCIPAL, APP_PRINCIPAL));

    const noteCreates = requests.filter((r) => r.method === "POST" && r.url === "/rest/notes");
    expect(noteCreates).toHaveLength(RECIPIENTS.length);
  });
});
