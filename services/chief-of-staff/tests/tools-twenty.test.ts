import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import twentyLookup, { buildLookupQueries } from "../catalogue/twenty_lookup.js";
import twentyGetPerson from "../catalogue/twenty_get_person.js";
import twentyCompanyForPerson from "../catalogue/twenty_company_for_person.js";
import twentyNote from "../catalogue/twenty_note.js";
import twentySetStage from "../catalogue/twenty_set_stage.js";
import twentyCreateOpportunity from "../catalogue/twenty_create_opportunity.js";
import twentyCommState from "../catalogue/twenty_comm_state.js";
import twentyDoNotContact from "../catalogue/twenty_do_not_contact.js";
import { TwentyUnavailableError } from "../lib/twenty-client.js";
import { UnauthorizedApproverError } from "../lib/approvals.js";

/**
 * Task 5 — the Twenty tools, against a REAL local HTTP server (matching Task 3's
 * `tests/twenty-client.test.ts` style), not a fetch stub: proves the actual REST calls each
 * tool makes (method, path, body), the ORB-51 not-found/unavailable split on the reads, and
 * — for the five write tools — that the approval gate refuses BEFORE any HTTP call happens.
 */

const BENDIK = "U_EXAMPLE_OWNER";
const SOMEONE_ELSE = "U0BADBADBAD";
const TELEGRAM_BENDIK = "123456789";

function slackAuth(userId: string) {
  // The shape eve's Slack channel builds (buildSlackAuthContext): authenticator
  // "slack-webhook", the user id under attributes.user_id — matches tests/gate.test.ts.
  return {
    attributes: { user_id: userId, channel_id: "D123", thread_ts: "1.0" },
    authenticator: "slack-webhook",
    principalId: `slack:T1:${userId}`,
    principalType: "user",
  };
}

function telegramAuth(userId: string) {
  // The shape eve's Telegram channel builds (defaultTelegramAuth): authenticator
  // "telegram-webhook", the user id under attributes.user_id as a NUMBER — matches
  // tests/approvals.test.ts's principalFromAuth case.
  return {
    attributes: { chat_id: 555, chat_type: "private", user_id: Number(userId) },
    authenticator: "telegram-webhook",
    principalId: `telegram:${userId}`,
    principalType: "user",
  };
}

function ctx(auth: unknown) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

let server: Server | undefined;
let keyDir: string;
let requests: Recorded[];

/** A stub Twenty that records every request it receives and answers with `responses`,
 *  consumed in call order. A request past the end of the list gets a harmless 200/{} —
 *  tests that care about call count assert `requests.length` directly rather than relying
 *  on running out of canned responses. */
function listen(responses: Array<{ status: number; body: unknown }>): Promise<void> {
  let i = 0;
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
        requests.push({ method: req.method ?? "", url: req.url ?? "", body });
        const next = responses[i] ?? { status: 200, body: { data: {} } };
        i++;
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(JSON.stringify(next.body));
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
  keyDir = mkdtempSync(join(tmpdir(), "twenty-tools-key-"));
  writeFileSync(join(keyDir, "twenty-key"), "test-api-key\n");
  process.env["TWENTY_KEY_FILE"] = join(keyDir, "twenty-key");
  process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK;
  process.env["TELEGRAM_PRINCIPAL_ID"] = TELEGRAM_BENDIK;
});

afterEach(async () => {
  delete process.env["TWENTY_BASE_URL"];
  delete process.env["TWENTY_KEY_FILE"];
  delete process.env["SLACK_ALLOWED_USER_IDS"];
  delete process.env["TELEGRAM_PRINCIPAL_ID"];
  rmSync(keyDir, { recursive: true, force: true });
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

const READ_CTX = {} as never;

// -----------------------------------------------------------------------------------------
// Reads — free, no approval required
// -----------------------------------------------------------------------------------------

describe("twenty_lookup", () => {
  it("dedupes people across sub-queries and returns matched companies", async () => {
    const queries = buildLookupQueries("Jane Doe");
    expect(queries).toHaveLength(3); // firstName, lastName, company-name

    await listen([
      {
        status: 200,
        body: {
          data: {
            people: [
              { id: "p1", name: { firstName: "Jane", lastName: "Doe" }, emails: { primaryEmail: "jane@x.com" }, companyId: "c1" },
            ],
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            people: [
              { id: "p1", name: { firstName: "Jane", lastName: "Doe" }, emails: { primaryEmail: "jane@x.com" }, companyId: "c1" },
              { id: "p2", name: { firstName: "Janet", lastName: "Doe" }, emails: {}, companyId: null },
            ],
          },
        },
      },
      { status: 200, body: { data: { companies: [{ id: "c1", name: "Acme" }] } } },
    ]);

    const result = await twentyLookup.execute({ name: "Jane Doe" }, READ_CTX);

    expect(result).toEqual({
      people: [
        { id: "p1", name: "Jane Doe", email: "jane@x.com", companyId: "c1" },
        { id: "p2", name: "Janet Doe", email: null, companyId: null },
      ],
      companies: [{ id: "c1", name: "Acme" }],
    });
    expect(requests.map((r) => r.url)).toEqual(queries.map((q) => `/rest${q.path}`));
  });

  it("an empty term returns an empty result without any HTTP call", async () => {
    const result = await twentyLookup.execute({ name: "   " }, READ_CTX);
    expect(result).toEqual({ people: [], companies: [] });
    expect(requests).toHaveLength(0);
  });

  it("propagates TwentyUnavailableError from a failed sub-query rather than swallowing it as a warning", async () => {
    await listen([{ status: 503, body: { error: "down" } }]);
    await expect(twentyLookup.execute({ name: "Jane Doe" }, READ_CTX)).rejects.toThrow(TwentyUnavailableError);
  });
});

describe("twenty_get_person", () => {
  it("returns the mapped person on a 200", async () => {
    await listen([
      {
        status: 200,
        body: {
          data: {
            person: {
              id: "p1",
              name: { firstName: "Ann", lastName: "Bo" },
              emails: { primaryEmail: "ann@x.com" },
              jobTitle: "CEO",
              linkedinLink: { primaryLinkUrl: "https://linkedin.com/in/ann" },
              companyId: "c1",
            },
          },
        },
      },
    ]);

    const result = await twentyGetPerson.execute({ recordId: "p1" }, READ_CTX);

    expect(result).toEqual({
      recordId: "p1",
      firstName: "Ann",
      lastName: "Bo",
      emails: ["ann@x.com"],
      role: "CEO",
      linkedinUrl: "https://linkedin.com/in/ann",
      companyId: "c1",
    });
    expect(requests).toEqual([{ method: "GET", url: "/rest/people/p1", body: undefined }]);
  });

  it("returns a typed not-found on a 404 — a real, expected outcome, not an error", async () => {
    await listen([{ status: 404, body: { error: "no such record" } }]);
    const result = await twentyGetPerson.execute({ recordId: "nope" }, READ_CTX);
    expect(result).toEqual({ ok: false, reason: "not found" });
  });

  it("propagates TwentyUnavailableError on a genuine backend failure", async () => {
    await listen([{ status: 503, body: { error: "down" } }]);
    await expect(twentyGetPerson.execute({ recordId: "p1" }, READ_CTX)).rejects.toThrow(TwentyUnavailableError);
  });
});

describe("twenty_company_for_person", () => {
  it("returns the linked company", async () => {
    await listen([
      {
        status: 200,
        body: { data: { person: { id: "p1", name: { firstName: "Ann", lastName: "Bo" }, emails: {}, companyId: "c1" } } },
      },
      {
        status: 200,
        body: { data: { company: { id: "c1", name: "Acme", domainName: { primaryLinkUrl: "acme.com" }, orgNumber: "123" } } },
      },
    ]);

    const result = await twentyCompanyForPerson.execute({ recordId: "p1" }, READ_CTX);

    expect(result).toEqual({ recordId: "c1", name: "Acme", domain: "acme.com", orgNumber: "123" });
    expect(requests.map((r) => r.url)).toEqual(["/rest/people/p1", "/rest/companies/c1"]);
  });

  it("returns no-linked-company when the person has no companyId (no second request)", async () => {
    await listen([
      { status: 200, body: { data: { person: { id: "p1", name: { firstName: "Ann", lastName: "Bo" }, emails: {}, companyId: null } } } },
    ]);
    const result = await twentyCompanyForPerson.execute({ recordId: "p1" }, READ_CTX);
    expect(result).toEqual({ ok: false, reason: "no linked company" });
    expect(requests).toHaveLength(1);
  });

  it("returns no-linked-company when the person doesn't exist", async () => {
    await listen([{ status: 404, body: {} }]);
    const result = await twentyCompanyForPerson.execute({ recordId: "ghost" }, READ_CTX);
    expect(result).toEqual({ ok: false, reason: "no linked company" });
  });

  it("returns no-linked-company when the linked company id is dangling", async () => {
    await listen([
      { status: 200, body: { data: { person: { id: "p1", name: { firstName: "Ann", lastName: "Bo" }, emails: {}, companyId: "gone" } } } },
      { status: 404, body: {} },
    ]);
    const result = await twentyCompanyForPerson.execute({ recordId: "p1" }, READ_CTX);
    expect(result).toEqual({ ok: false, reason: "no linked company" });
  });

  it("propagates TwentyUnavailableError from the person fetch", async () => {
    await listen([{ status: 503, body: {} }]);
    await expect(twentyCompanyForPerson.execute({ recordId: "p1" }, READ_CTX)).rejects.toThrow(TwentyUnavailableError);
  });

  it("propagates TwentyUnavailableError from the company fetch", async () => {
    await listen([
      { status: 200, body: { data: { person: { id: "p1", name: { firstName: "A", lastName: "B" }, emails: {}, companyId: "c1" } } } },
      { status: 503, body: {} },
    ]);
    await expect(twentyCompanyForPerson.execute({ recordId: "p1" }, READ_CTX)).rejects.toThrow(TwentyUnavailableError);
  });
});

// -----------------------------------------------------------------------------------------
// Writes — GATED. Every one of the five must: (1) refuse with no approver context and issue
// zero HTTP calls, (2) refuse a wrong/cross-channel approver the same way, (3) on a valid
// approver, issue exactly the REST call the old client made.
// -----------------------------------------------------------------------------------------

describe("twenty_note", () => {
  const UUID = "11111111-1111-1111-1111-111111111111";

  it("declares approval: always()", () => {
    expect(twentyNote.approval).toBeTypeOf("function");
  });

  it("refuses a present-but-unidentified approver context, before any HTTP call", async () => {
    await listen([]);
    await expect(twentyNote.execute({ target: UUID, body: "hi" }, ctx({}))).rejects.toThrow(UnauthorizedApproverError);
    expect(requests).toHaveLength(0);
  });

  it("refuses a wrong/cross-channel approver, before any HTTP call", async () => {
    await listen([]);
    await expect(twentyNote.execute({ target: UUID, body: "hi" }, ctx(slackAuth(SOMEONE_ELSE)))).rejects.toThrow(
      UnauthorizedApproverError,
    );
    expect(requests).toHaveLength(0);
  });

  it("refuses a Telegram-allowed id presented with the Slack authenticator, before any HTTP call", async () => {
    // TELEGRAM_BENDIK is a real, allowed principal — just on the wrong channel. Proves the
    // execute() call site checks the presented channel, not "is this id allowed anywhere".
    await listen([]);
    await expect(
      twentyNote.execute({ target: UUID, body: "hi" }, ctx(slackAuth(TELEGRAM_BENDIK))),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(requests).toHaveLength(0);
  });

  it("refuses a Slack-allowed id presented with the Telegram authenticator, before any HTTP call", async () => {
    // BENDIK ("U_EXAMPLE_OWNER") is Slack-shaped, not numeric — telegramAuth()'s Number(userId)
    // coercion turned it into NaN, so this case previously exercised "a NaN id is refused"
    // rather than "his real Slack id, presented on the wrong channel, is refused". Build the
    // Telegram auth context directly instead, with attributes.user_id set to the raw Slack id
    // STRING — principalFromAuth() (lib/principals.ts) accepts a string there natively, so
    // this now genuinely proves a Slack-allowed id is refused under the Telegram authenticator,
    // not an artifact of the coercion.
    await listen([]);
    await expect(
      twentyNote.execute(
        { target: UUID, body: "hi" },
        ctx({
          attributes: { chat_id: 555, chat_type: "private", user_id: BENDIK },
          authenticator: "telegram-webhook",
          principalId: `telegram:${BENDIK}`,
          principalType: "user",
        }),
      ),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(requests).toHaveLength(0);
  });

  it("on a valid approver, creates the note and links it by id", async () => {
    await listen([
      { status: 200, body: { data: { note: { id: "note_1" } } } },
      { status: 200, body: { data: { noteTarget: { id: "nt_1" } } } },
    ]);

    const result = await twentyNote.execute({ target: UUID, body: "hello there" }, ctx(slackAuth(BENDIK)));

    expect(result).toEqual({ id: "note_1" });
    expect(requests).toEqual([
      { method: "POST", url: "/rest/notes", body: { title: "hello there", bodyV2: { markdown: "hello there" } } },
      { method: "POST", url: "/rest/noteTargets", body: { noteId: "note_1", targetPersonId: UUID } },
    ]);
  });
});

describe("twenty_set_stage", () => {
  it("refuses a present-but-unidentified approver context, before any HTTP call", async () => {
    await listen([]);
    await expect(twentySetStage.execute({ opportunityId: "opp1", stage: "won" }, ctx({}))).rejects.toThrow(
      UnauthorizedApproverError,
    );
    expect(requests).toHaveLength(0);
  });

  it("refuses a wrong/cross-channel approver, before any HTTP call", async () => {
    await listen([]);
    await expect(
      twentySetStage.execute({ opportunityId: "opp1", stage: "won" }, ctx(slackAuth(SOMEONE_ELSE))),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(requests).toHaveLength(0);
  });

  it("on a valid approver, PATCHes the opportunity's stage", async () => {
    await listen([{ status: 200, body: { data: { opportunity: { id: "opp1", stage: "won" } } } }]);
    const result = await twentySetStage.execute({ opportunityId: "opp1", stage: "won" }, ctx(slackAuth(BENDIK)));
    expect(result).toEqual({ ok: true });
    expect(requests).toEqual([{ method: "PATCH", url: "/rest/opportunities/opp1", body: { stage: "won" } }]);
  });
});

describe("twenty_create_opportunity", () => {
  it("refuses a present-but-unidentified approver context, before any HTTP call", async () => {
    await listen([]);
    await expect(
      twentyCreateOpportunity.execute({ name: "Deal", stage: "new", brand: "zero7" }, ctx({})),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(requests).toHaveLength(0);
  });

  it("refuses a wrong/cross-channel approver, before any HTTP call", async () => {
    await listen([]);
    await expect(
      twentyCreateOpportunity.execute({ name: "Deal", stage: "new", brand: "zero7" }, ctx(slackAuth(SOMEONE_ELSE))),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(requests).toHaveLength(0);
  });

  it("on a valid approver, POSTs the opportunity and returns its id", async () => {
    await listen([{ status: 200, body: { data: { opportunity: { id: "opp2" } } } }]);
    const result = await twentyCreateOpportunity.execute(
      { name: "Deal", stage: "new", brand: "zero7" },
      ctx(slackAuth(BENDIK)),
    );
    expect(result).toEqual({ id: "opp2" });
    expect(requests).toEqual([{ method: "POST", url: "/rest/opportunities", body: { name: "Deal", stage: "new", brand: "zero7" } }]);
  });

  it("includes pointOfContactId in the body only when given", async () => {
    await listen([{ status: 200, body: { data: { opportunity: { id: "opp3" } } } }]);
    await twentyCreateOpportunity.execute(
      { name: "Deal", stage: "new", brand: "zero7", pointOfContactId: "p1" },
      ctx(slackAuth(BENDIK)),
    );
    expect(requests[0]!.body).toEqual({ name: "Deal", stage: "new", brand: "zero7", pointOfContactId: "p1" });
  });
});

describe("twenty_comm_state", () => {
  it("refuses a present-but-unidentified approver context, before any HTTP call", async () => {
    await listen([]);
    await expect(
      twentyCommState.execute({ recordId: "p1", state: "replied_positive", expectedPrevious: "email_sent" }, ctx({})),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(requests).toHaveLength(0);
  });

  it("refuses a wrong/cross-channel approver, before any HTTP call", async () => {
    await listen([]);
    await expect(
      twentyCommState.execute(
        { recordId: "p1", state: "replied_positive", expectedPrevious: "email_sent" },
        ctx(slackAuth(SOMEONE_ELSE)),
      ),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(requests).toHaveLength(0);
  });

  it("on a valid approver with a matching expectedPrevious, reads then PATCHes", async () => {
    await listen([
      { status: 200, body: { data: { person: { id: "p1", commState: "email_sent" } } } },
      { status: 200, body: { data: { person: { id: "p1", commState: "replied_positive" } } } },
    ]);
    const result = await twentyCommState.execute(
      { recordId: "p1", state: "replied_positive", expectedPrevious: "email_sent" },
      ctx(slackAuth(BENDIK)),
    );
    expect(result).toEqual({ ok: true });
    expect(requests).toEqual([
      { method: "GET", url: "/rest/people/p1", body: undefined },
      { method: "PATCH", url: "/rest/people/p1", body: { commState: "replied_positive" } },
    ]);
  });

  it("skips the write, without error, when a human changed the state first", async () => {
    await listen([{ status: 200, body: { data: { person: { id: "p1", commState: "replied_negative" } } } }]);
    const result = await twentyCommState.execute(
      { recordId: "p1", state: "replied_positive", expectedPrevious: "email_sent" },
      ctx(slackAuth(BENDIK)),
    );
    expect(result).toEqual({ ok: true, skipped: true, reason: "rep_edit_detected" });
    expect(requests).toHaveLength(1); // read only, no PATCH
  });

  // ORB-93 — expectedPrevious OMITTED used to be treated as an assertion of null, so ANY
  // follow-up call on a person already past "never contacted" hit a CAS mismatch and
  // silently no-op'd forever: comm-state never advanced past the first hop. Omitting it now
  // means "no assertion, set unconditionally" — this is agent/skills/sales-outreach.md's
  // own send-time call shape (state: "email_sent", no expectedPrevious).
  it("omitted expectedPrevious sets unconditionally, even over a non-null current value", async () => {
    await listen([
      { status: 200, body: { data: { person: { id: "p1", commState: "replied_negative" } } } },
      { status: 200, body: { data: { person: { id: "p1", commState: "email_sent" } } } },
    ]);
    const result = await twentyCommState.execute({ recordId: "p1", state: "email_sent" }, ctx(slackAuth(BENDIK)));
    expect(result).toEqual({ ok: true });
    expect(requests).toEqual([
      { method: "GET", url: "/rest/people/p1", body: undefined },
      { method: "PATCH", url: "/rest/people/p1", body: { commState: "email_sent" } },
    ]);
  });

  it("an EXPLICIT expectedPrevious: null still asserts 'must currently be unset'", async () => {
    await listen([{ status: 200, body: { data: { person: { id: "p1", commState: "email_sent" } } } }]);
    const result = await twentyCommState.execute(
      { recordId: "p1", state: "replied_positive", expectedPrevious: null },
      ctx(slackAuth(BENDIK)),
    );
    expect(result).toEqual({ ok: true, skipped: true, reason: "rep_edit_detected" });
    expect(requests).toHaveLength(1); // read only, no PATCH — the explicit null assertion still protects
  });

  // The full state machine, old pipeline's values: never_contacted (null) → email_sent →
  // replied_positive — proving the chain actually advances end to end now.
  it("advances the full transition chain: null → email_sent → replied_positive", async () => {
    await listen([
      { status: 200, body: { data: { person: { id: "p1", commState: null } } } },     // read before email_sent
      { status: 200, body: { data: { person: { id: "p1", commState: "email_sent" } } } }, // patch response (ignored)
      { status: 200, body: { data: { person: { id: "p1", commState: "email_sent" } } } }, // read before replied_positive
      { status: 200, body: { data: { person: { id: "p1", commState: "replied_positive" } } } },
    ]);
    // Step 1 — send-time call, exactly as sales-outreach.md makes it: no expectedPrevious.
    const step1 = await twentyCommState.execute({ recordId: "p1", state: "email_sent" }, ctx(slackAuth(BENDIK)));
    expect(step1).toEqual({ ok: true });
    // Step 2 — reply-triage's call (lib/outreach-reply-triage.ts): asserts the prior state.
    const step2 = await twentyCommState.execute(
      { recordId: "p1", state: "replied_positive", expectedPrevious: "email_sent" },
      ctx(slackAuth(BENDIK)),
    );
    expect(step2).toEqual({ ok: true });
    expect(requests.map((r) => r.method)).toEqual(["GET", "PATCH", "GET", "PATCH"]);
  });

  it("returns a typed not-found on a 404 read, distinct from an unavailable backend", async () => {
    await listen([{ status: 404, body: {} }]);
    const result = await twentyCommState.execute(
      { recordId: "ghost", state: "replied_positive", expectedPrevious: null },
      ctx(slackAuth(BENDIK)),
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("propagates TwentyUnavailableError from the read", async () => {
    await listen([{ status: 503, body: {} }]);
    await expect(
      twentyCommState.execute({ recordId: "p1", state: "x", expectedPrevious: null }, ctx(slackAuth(BENDIK))),
    ).rejects.toThrow(TwentyUnavailableError);
  });
});

describe("twenty_do_not_contact", () => {
  it("refuses a present-but-unidentified approver context, before any HTTP call", async () => {
    await listen([]);
    await expect(twentyDoNotContact.execute({ recordId: "p1", reason: "bounced" }, ctx({}))).rejects.toThrow(
      UnauthorizedApproverError,
    );
    expect(requests).toHaveLength(0);
  });

  it("refuses a wrong/cross-channel approver, before any HTTP call", async () => {
    await listen([]);
    await expect(
      twentyDoNotContact.execute({ recordId: "p1", reason: "bounced" }, ctx(slackAuth(SOMEONE_ELSE))),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(requests).toHaveLength(0);
  });

  it("on a valid approver, PATCHes doNotContact and the reason", async () => {
    await listen([{ status: 200, body: { data: { person: { id: "p1" } } } }]);
    const result = await twentyDoNotContact.execute({ recordId: "p1", reason: "bounced" }, ctx(slackAuth(BENDIK)));
    expect(result).toEqual({ ok: true });
    expect(requests).toEqual([
      { method: "PATCH", url: "/rest/people/p1", body: { doNotContact: true, doNotContactReason: "bounced" } },
    ]);
  });
});
