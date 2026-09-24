import { describe, it, expect } from "vitest";
import { contractClauses } from "@lares/compose-contract";

import { buildReplyPrompt } from "../lib/reply-prompt.js";

/**
 * ORB-176 — the ONE reply prompt both drafters use (email-triage, outreach-reply-triage),
 * written for a thinking writer. What it must and must not do:
 *
 *  - No brevity rule. "Write a brief, warm, specific reply" produced 130–650 tokens of text on
 *    2026-09-07 and read as thin next to the same person's real mail. Length comes from the
 *    examples, not from an adjective.
 *  - Examples FIRST, guide second. Bendik's own sent mail is the strongest evidence of how he
 *    writes; the distilled bullet list is a summary of it and must not outrank it.
 *  - The compose contract (language, no commitments) stays verbatim — it is shared law.
 *  - The exact return-format line stays — splitDraft parses it.
 */
const base = {
  account: "owner@owner.example",
  lang: "no" as const,
  voiceBlock: "Write in Bendik's own email voice — this email is from Bendik personally. Follow this voice guide:\n- Warm, short",
  examples: ["Hei Kjetil,\n\nTakk for i går — dette var nyttig.\n\nBendik", "Hei Stefan,\n\nSkjønner! Vi tar det på fredag.\n\nBendik"],
  contextBlocks: "CRM record:\n- Taylor Example, Folkepuls",
  closing: "\n\nDo NOT write any closing line or sign-off (no \"Mvh\", no name) — the mailbox signature is appended automatically after your text. End with your final sentence.\n",
  original: { from: "taylor@example.com", subject: "Re: Folkepuls", body: "Hei Bendik, når kan vi ta byggesakene?" },
};

describe("buildReplyPrompt — one prompt for both drafters, written for a thinking writer", () => {
  it("never asks for a brief reply — length is taken from the examples", () => {
    const p = buildReplyPrompt(base);
    expect(p.toLowerCase()).not.toMatch(/\bbrief\b/);
    expect(p).toContain("Match their length, register and warmth");
  });

  it("puts the sent-mail examples before the distilled voice guide", () => {
    const p = buildReplyPrompt(base);
    const examplesAt = p.indexOf("Hei Kjetil,");
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
    expect(p).toContain("Subject: Re: Folkepuls");
    expect(p).toContain("når kan vi ta byggesakene?");
  });

  it("includes the caller's extra rules verbatim, and omits empty blocks without leaving gaps", () => {
    const p = buildReplyPrompt({ ...base, examples: [], contextBlocks: "", extraRules: ["Do NOT invent a phone number."] });
    expect(p).toContain("Do NOT invent a phone number.");
    expect(p).not.toContain("Match their length");
    expect(p).not.toContain("Context —");
    expect(p).not.toMatch(/\n{3,}/);
  });
});
