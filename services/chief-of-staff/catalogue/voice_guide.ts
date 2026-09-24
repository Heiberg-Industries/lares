// Get Bendik's writing-voice guide before drafting an email in his voice (ORB-75/76 — ported
// from services/agent-runtime/lib/voice/{profile,store}.ts). Read-only, not gated: this
// returns guidance text and past-email examples, it writes nothing and sends nothing.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { makeDbVoiceAccess } from "../lib/voice-store.js";
import { detectLanguage, buildVoiceBlock } from "../lib/voice.js";

export default defineTool({
  description:
    "Get Bendik's writing-voice guide before drafting an email from him. Pass a short " +
    "description of what the email is about (used to detect language and find similar past " +
    "emails). Returns voice instructions to follow and up to 3 example emails in the same " +
    "language for grounding — both may be empty if no voice profile is set up yet, in which " +
    "case draft normally.",
  inputSchema: z.object({
    topic: z.string().describe("What the email is about, in a sentence — used for language detection and example retrieval"),
    account: z.string().describe("The mailbox this email will be sent FROM — examples are drawn from that mailbox's own sent mail, since you write differently to different audiences"),
    lang: z.enum(["en", "no"]).optional().describe("Override language detection if you already know it"),
  }),
  async execute({ topic, account, lang }) {
    const db = getPool();
    const voice = makeDbVoiceAccess({ db, mailbox: account });
    const language = lang ?? detectLanguage(topic);
    const profile = await voice.getProfile();
    const voiceGuide = buildVoiceBlock(profile, language);

    // A retrieval failure must not block the draft — the rules alone still write a decent
    // email — but it must never masquerade as "this mailbox has no examples" (ORB-119).
    // The model is told which of the two happened, and the log carries the reason.
    let exampleEmails: string[] = [];
    let examplesUnavailable = false;
    try {
      exampleEmails = await voice.retrieve(topic, 3, language);
    } catch (err) {
      examplesUnavailable = true;
      console.error(`voice_guide: example retrieval FAILED for ${account} — drafting from the card alone`, err);
    }

    return {
      voiceGuide: voiceGuide || null,
      exampleEmails,
      examplesUnavailable,
    } as const;
  },
});
