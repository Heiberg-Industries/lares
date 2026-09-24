import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ORB-278 step 1, Task 3b (fix round 1, 2026-09-15) — `lib/contact-history.ts`'s
 * `isKnownRecipient` (the engine's `ContactHistory` contract, `@lares/agent-kit/board-approval`),
 * exercised with each source faked — no real network replica or Gmail involved. Mocking follows
 * tests/meeting-followup-crm-note.test.ts's `vi.mock("../lib/google.js", ...)` style.
 *
 * Rewritten for the fix-round-1 review's owner rulings (task-3b-fix1-findings.md):
 *   - D-A: the CRM (Twenty) is REMOVED as a source entirely — no more `twenty-client.js` mock,
 *     no more commState cases.
 *   - D-B: "known" now means the OWNER wrote to them — the mail leg is SENT-only, verified
 *     against the returned message's own To/Cc/Bcc headers (not trusted from the search alone).
 *
 * All test addresses are example.com/example.org — this repo is the ENGINE; no installation-
 * specific (real owner) address belongs in it (fix-round-1 review, I9).
 *
 * Order matters and is asserted where it changes what the test proves: network first (local,
 * cheap), then mail — known as soon as one source says yes, so mail is never consulted once
 * network already found the recipient.
 */

const networkHasInteractionMock = vi.fn<(email: string) => boolean>();
vi.mock("../lib/network-client.js", () => ({
  networkHasOutboundInteraction: (email: string) => networkHasInteractionMock(email),
}));

interface FakeMailMessage { to: string[]; cc: string[]; bcc?: string[] }

const gmailFactoryMock = vi.fn<(account?: string) => Promise<{ search: typeof gmailSearchMock; read: typeof gmailReadMock }>>();
const gmailSearchMock = vi.fn<(query: string, max: number) => Promise<string[]>>();
const gmailReadMock = vi.fn<(id: string) => Promise<FakeMailMessage | null>>();
vi.mock("../lib/google.js", () => ({
  googleClients: () => ({ gmail: (account?: string) => gmailFactoryMock(account) }),
}));

import { addressOf, isKnownRecipient } from "../lib/contact-history.js";

beforeEach(() => {
  vi.clearAllMocks();
  gmailFactoryMock.mockResolvedValue({ search: gmailSearchMock, read: gmailReadMock });
  gmailSearchMock.mockResolvedValue([]);
  gmailReadMock.mockResolvedValue(null);
  networkHasInteractionMock.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isKnownRecipient", () => {
  it("known via the network replica — mail is never consulted", async () => {
    networkHasInteractionMock.mockReturnValue(true);
    await expect(isKnownRecipient("person@example.com", {})).resolves.toBe(true);
    expect(gmailFactoryMock).not.toHaveBeenCalled();
  });

  it("known via a SENT message that has the recipient in To (header-verified)", async () => {
    gmailSearchMock.mockResolvedValue(["m1"]);
    gmailReadMock.mockResolvedValue({ to: ["Person <person@example.com>"], cc: [] });
    await expect(isKnownRecipient("person@example.com", { account: "owner@example.org" })).resolves.toBe(true);
    expect(gmailFactoryMock).toHaveBeenCalledWith("owner@example.org");
    expect(gmailSearchMock).toHaveBeenCalledWith(expect.stringContaining("in:sent"), expect.any(Number));
    expect(gmailSearchMock).toHaveBeenCalledWith(expect.stringContaining("person@example.com"), expect.any(Number));
  });

  it("known via a SENT message with the recipient only in Cc", async () => {
    gmailSearchMock.mockResolvedValue(["m1"]);
    gmailReadMock.mockResolvedValue({ to: ["other@example.com"], cc: ["person@example.com"] });
    await expect(isKnownRecipient("person@example.com", {})).resolves.toBe(true);
  });

  it("known via a SENT message with the recipient only in Bcc", async () => {
    gmailSearchMock.mockResolvedValue(["m1"]);
    gmailReadMock.mockResolvedValue({ to: ["other@example.com"], cc: [], bcc: ["person@example.com"] });
    await expect(isKnownRecipient("person@example.com", {})).resolves.toBe(true);
  });

  // D-B: inbound mail (the owner only RECEIVED from this address) must never count.
  it("NOT known when the only mail is inbound — search matched but the candidate isn't in To/Cc/Bcc", async () => {
    gmailSearchMock.mockResolvedValue(["m1"]);
    // Simulates Gmail's search returning a candidate that does not actually carry the address
    // in any of To/Cc/Bcc (e.g. it only matched From, or a near-miss token) — the header
    // verification step must reject it.
    gmailReadMock.mockResolvedValue({ to: ["someone-else@example.com"], cc: [] });
    await expect(isKnownRecipient("person@example.com", {})).resolves.toBe(false);
  });

  it("does not trust the search alone — a near-miss local part at another domain is rejected by header verification", async () => {
    gmailSearchMock.mockResolvedValue(["m1"]);
    gmailReadMock.mockResolvedValue({ to: ["person@another-example.com"], cc: [] });
    await expect(isKnownRecipient("person@example.com", {})).resolves.toBe(false);
  });

  it("all sources fail — throws rather than answering known or unknown", async () => {
    networkHasInteractionMock.mockImplementation(() => { throw new Error("network db unreadable"); });
    gmailSearchMock.mockRejectedValue(new Error("gmail unavailable"));
    await expect(isKnownRecipient("person@example.com", {})).rejects.toThrow();
  });

  it("one source fails and the other says yes — still known", async () => {
    networkHasInteractionMock.mockImplementation(() => { throw new Error("network db unreadable"); });
    gmailSearchMock.mockResolvedValue(["m1"]);
    gmailReadMock.mockResolvedValue({ to: ["person@example.com"], cc: [] });
    await expect(isKnownRecipient("person@example.com", {})).resolves.toBe(true);
  });

  // Fix round 1, I5: one source throws while the OTHER answers "no" (not "yes") — must still
  // throw, not silently resolve to false.
  it("one source throws and the other answers cleanly with no evidence — still throws", async () => {
    networkHasInteractionMock.mockImplementation(() => { throw new Error("network db unreadable"); });
    gmailSearchMock.mockResolvedValue([]);
    await expect(isKnownRecipient("person@example.com", {})).rejects.toThrow();
  });

  it("every source answers cleanly with no evidence — known is false, no throw", async () => {
    await expect(isKnownRecipient("person@example.com", {})).resolves.toBe(false);
  });

  // Fix round 1, I4: no recipient address, and no raw error message, may reach the log.
  it("never logs the recipient address or the underlying error message on a source failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    networkHasInteractionMock.mockImplementation(() => {
      throw new Error("lookup for person@example.com failed against /srv/network/network.db");
    });
    gmailSearchMock.mockRejectedValue(new Error("gmail search failed for person@example.com"));
    await expect(isKnownRecipient("person@example.com", {})).rejects.toThrow();

    const logged = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).not.toContain("person@example.com");
    expect(logged).not.toContain("failed against");
    expect(logged).not.toContain("gmail search failed");
    errorSpy.mockRestore();
  });
});

// Fix round 2, item 1: `addressOf` took the FIRST '<...>' anywhere in the header entry — the
// same flaw fix round 1's C1 fixed on the PARSING side, still present here on the VERIFICATION
// side. A crafted entry puts a fake address inside a quoted display name and the real
// recipient in the trailing '<...>'; taking the first match misreads the fake one as real.
describe("addressOf — takes the LAST '<...>' ending the entry, not the first", () => {
  it("extracts the address from an ordinary 'Name <addr>' entry", () => {
    expect(addressOf("Person <person@example.com>")).toBe("person@example.com");
  });

  it("returns a bare address unchanged, lowercased, when there is no display name", () => {
    expect(addressOf("Person@Example.com")).toBe("person@example.com");
  });

  it("does NOT return the fake address hidden inside a quoted display name — a crafted entry is no match", () => {
    expect(addressOf('"<victim@target.example>" <stranger@evil.example>')).toBe("");
  });

  it("also refuses a display name containing a bare @ outside any angle brackets", () => {
    expect(addressOf("weird@name <real@example.com>")).toBe("");
  });

  it("prevents isKnownRecipient's mail leg from crediting a stranger's crafted display name to the victim address", async () => {
    gmailSearchMock.mockResolvedValue(["m1"]);
    gmailReadMock.mockResolvedValue({ to: ['"<victim@target.example>" <stranger@evil.example>'], cc: [] });
    await expect(isKnownRecipient("victim@target.example", {})).resolves.toBe(false);
  });

  // Final review F10: a display name that IS the address (common: `"a@x.com" <a@x.com>`) is the same
  // recipient, not a crafted entry — counting it as no match cost a needless card.
  describe("a display name equal to the address", () => {
    it("accepts it quoted or bare, case-insensitively", () => {
      expect(addressOf('"person@example.com" <person@example.com>')).toBe("person@example.com");
      expect(addressOf("person@example.com <person@example.com>")).toBe("person@example.com");
      expect(addressOf('"Person@Example.com" <person@example.com>')).toBe("person@example.com");
    });
    it("still refuses a display name carrying a DIFFERENT address", () => {
      expect(addressOf('"other@example.com" <person@example.com>')).toBe("");
      expect(addressOf('"person@example.com " <person@example.com>')).toBe("");
      expect(addressOf('"<person@example.com>" <person@example.com>')).toBe("");
    });
    it("lets isKnownRecipient's mail leg count a sent message addressed that way", async () => {
      gmailSearchMock.mockResolvedValue(["m1"]);
      gmailReadMock.mockResolvedValue({ to: ['"person@example.com" <person@example.com>'], cc: [] });
      await expect(isKnownRecipient("person@example.com", {})).resolves.toBe(true);
    });
  });
});
