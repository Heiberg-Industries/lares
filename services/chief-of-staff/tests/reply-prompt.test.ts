import { describe, it, expect } from "vitest";
import { contractClauses } from "@lares/compose-contract";

import { buildReplyPrompt } from "../lib/reply-prompt.js";

/**
 * — the ONE reply prompt both drafters use (email-triage, outreach-reply-triage),
 * written for a thinking writer. What it must and must not do:
 *
 *  - No brevity rule. "Write a brief, warm, specific reply" produced 130–650 tokens of text
 *    and read as thin next to the same person's real mail. Length comes from the
 *    examples, not from an adjective.
 *  - Examples FIRST, guide second. the owner's own sent mail is the strongest evidence of how he
 *    writes; the distilled bullet list is a summary of it and must not outrank it.
 *  - The compose contract (language, no commitments) stays verbatim — it is shared law.
 *  - The exact return-format line stays — splitDraft parses it.
 */
const base = {
  account: "owner@owner.example",
  lang: "no" as const,
  voiceBlock: "Write in Test Owner's own email voice — this email is from Test Owner personally. Follow this voice guide:\n- Warm, short",
  examples: [
    { text: "Hei Mats,\n\nTakk for i går — dette var nyttig.\n\nHilsen\nOwner", toThisPerson: false },
    { text: "Hei Henrik,\n\nSkjønner! Vi tar det på fredag.\n\nHilsen\nOwner", toThisPerson: false },
  ],
  contextBlocks: "CRM record:\n- Taylor Example, Weekly Sync",
  closing: "\n\nDo NOT write any closing line or sign-off (no \"Mvh\", no name) — the mailbox signature is appended automatically after your text. End with your final sentence.\n",
  original: { from: "taylor@example.com", subject: "Re: Weekly Sync", body: "Hei Test Owner, når kan vi ta byggesakene?" },
};

describe("buildReplyPrompt — one prompt for both drafters, written for a thinking writer", () => {
  it("never asks for a brief reply — length is taken from the examples", () => {
    const p = buildReplyPrompt(base);
    expect(p.toLowerCase()).not.toMatch(/\bbrief\b/);
    expect(p).toContain("Match their length, register and warmth");
  });

  it("puts the sent-mail examples before the distilled voice guide", () => {
    const p = buildReplyPrompt(base);
    const examplesAt = p.indexOf("Hei Mats,");
    const guideAt = p.indexOf("Follow this voice guide");
    expect(examplesAt).toBeGreaterThan(-1);
    expect(guideAt).toBeGreaterThan(examplesAt);
  });

  it("carries the compose contract verbatim for the language", () => {
    const p = buildReplyPrompt(base);
    expect(p).toContain(contractClauses({ lang: "no", noCommitments: true }));
  });

  it("ends with the exact return-format line splitDraft parses", () => {
    const p = buildReplyPrompt(base);
    expect(p.trimEnd().endsWith('Return ONLY the reply in exactly: "Subject: <subject>\\n\\n<body>" — no commentary, no placeholders like "[Name]".')).toBe(true);
  });

  it("names the mailbox the reply leaves from and quotes the original", () => {
    const p = buildReplyPrompt(base);
    expect(p).toContain("sent from owner@owner.example");
    expect(p).toContain("From: taylor@example.com");
    expect(p).toContain("Subject: Re: Weekly Sync");
    expect(p).toContain("når kan vi ta byggesakene?");
  });

  it("includes the caller's extra rules verbatim, and omits empty blocks without leaving gaps", () => {
    const p = buildReplyPrompt({ ...base, examples: [], contextBlocks: "", extraRules: ["Do NOT invent a phone number."] });
    expect(p).toContain("Do NOT invent a phone number.");
    expect(p).not.toContain("Match their length");
    expect(p).not.toContain("Context —");
    expect(p).not.toMatch(/\n{3,}/);
  });

  it("renders the mail to this person first, then the other examples, each in its own tag", () => {
    const p = buildReplyPrompt({
      ...base,
      examples: [
        { text: "Other one", toThisPerson: false },
        { text: "Hei Taylor, to deg", toThisPerson: true },
      ],
    });
    const same = p.indexOf("sent to this same person");
    const other = p.indexOf("Other emails");
    expect(same).toBeGreaterThan(-1);
    expect(other).toBeGreaterThan(same);
    expect(p.indexOf("Hei Taylor, to deg")).toBeGreaterThan(same);
    expect(p.indexOf("Hei Taylor, to deg")).toBeLessThan(other);
    expect(p).toContain("<example>\nHei Taylor, to deg\n</example>");
    expect(p).toContain("<example>\nOther one\n</example>");
  });

  it("drops an empty group's heading entirely", () => {
    const onlyOther = buildReplyPrompt({ ...base, examples: [{ text: "x one", toThisPerson: false }] });
    expect(onlyOther).not.toContain("same person");
    const onlySame = buildReplyPrompt({ ...base, examples: [{ text: "x one", toThisPerson: true }] });
    expect(onlySame).not.toContain("Other emails");
  });

  it("keeps the owner's examples outside the outside-text block", () => {
    const p = buildReplyPrompt({ ...base, examples: [{ text: "Hei Taylor, to deg", toThisPerson: true }] });
    const exampleAt = p.indexOf("Hei Taylor, to deg");
    const blockAt = p.indexOf("Original email");
    expect(exampleAt).toBeGreaterThan(-1);
    expect(blockAt).toBeGreaterThan(exampleAt);
  });
});
