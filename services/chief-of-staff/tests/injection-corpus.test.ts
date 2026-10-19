// Slice 1 of the injection test suite, layer B: prompt assembly without a model.
// The corpus (packages/compose-contract/fixtures/injection) is walked through every pure prompt
// builder that takes text somebody else wrote. For each (builder, slot, case) the prompt must
//   1. carry the payload inside a block flagged third-party (heading, then the standing sentence,
//      then the content with no blank line between: a payload in prose after a flagged block does
//      not count),
//   2. carry THIRD_PARTY_NOTICE,
//   3. keep the case's marker out of the instruction half (the prompt with the payload cut out).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { THIRD_PARTY_NOTICE, neutraliseHeadings } from "@lares/compose-contract";
import { loadInjectionCorpus, type InjectionCase } from "../../../packages/compose-contract/tests/injection-corpus.js";
import { buildFollowupPrompt } from "../lib/meeting-followup.js";
import { classifyItem, classifyArticle } from "../lib/digest/classifier.js";
import {
  travelContextBlock, conflictsBlock, deadlinesBlock, signalsBlock,
  type NightBeforeMeeting, type Obligation, type BriefContent, type DeadlineLine,
} from "../lib/brief-content.js";
import type { ResolvedConflict } from "../lib/conflict-resolution.js";
import type { SignalRow } from "@lares/agent-kit/signals-client";
import { buildMorningPrompt } from "../agent/schedules/morning-brief.js";
import { buildEveningPrompt } from "../agent/schedules/evening-brief.js";
import { buildReplyPrompt } from "../lib/reply-prompt.js";
import { triageOneMessage } from "../lib/email-triage.js";
import type { GmailClient, MailMessage, ThreadMessage } from "../lib/google.js";

vi.mock("../lib/llm-complete.js", () => ({ gatewayComplete: vi.fn() }));
vi.mock("../catalogue/twenty_lookup.js", () => ({ twentyLookup: vi.fn(async () => ({ people: [], companies: [] })) }));
import { gatewayComplete } from "../lib/llm-complete.js";

const corpus = loadInjectionCorpus();

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
const WHEN = new Date("2026-10-14T09:00:00Z");
const meeting = (title: string, kind: NightBeforeMeeting["kind"]): NightBeforeMeeting => ({
  title, startsAt: WHEN, endsAt: new Date("2026-10-14T10:00:00Z"), participants: kind === "in-person" ? ["a@example.com"] : [], kind,
});
const obligation = (subject: string): Obligation => ({
  threadId: "t1", subject, counterpartyName: "Kari Nordmann", counterpartyAddress: "kari@example.com",
  lastMessageAt: WHEN, ageHours: 50, isRePing: false, unansweredCount: 1, source: "gmail",
});
const brief = (over: Partial<BriefContent>): BriefContent => ({ meetings: [], obligations: [], picks: [], ...over });
const deadline = (over: Partial<DeadlineLine>): DeadlineLine => ({
  id: "d1", entity: "Example AS", title: "Annual report", dueDate: "2026-10-20", daysToDue: 6,
  consequence: null, source: "statutory", ...over,
});
const signal = (title: string): SignalRow => ({
  fingerprint: "s1", occurrence: 1, kind: "alert", severity: "error", state: "open", title, project: "example",
  source: "job", type: "job", description: null, url: null, firstSeen: "2026-10-14T06:00:00Z",
  lastSeen: "2026-10-14T07:00:00Z", count: 1, linearRef: null,
});
const conflict = (over: Partial<ResolvedConflict>): ResolvedConflict => ({
  kind: "double-booked", severity: "high", events: [], explanation: "two entries overlap", ...over,
});
const mail = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: "m1", threadId: "t1", from: "Prospect <p@example.com>", to: ["owner@project.example"], subject: "Question",
  bodyText: "Hi, what does this cost?", sentAt: "2026-10-14", messageId: "<o@example.com>", references: "",
  isCalendarNotice: false, isBulk: false, cc: [], ...over,
});
const threadMsg = (over: Partial<ThreadMessage>): ThreadMessage => ({
  ...mail({ id: "tm1", from: "them@example.com", sentAt: "2026-10-13T10:00:00Z", messageId: "<tm1@example.com>" }), headers: {}, ...over,
});
const fakeGmail = (): GmailClient => ({
  search: vi.fn(async () => []), searchThreadIds: vi.fn(async () => []), read: vi.fn(async () => null),
  readThread: vi.fn(async () => []), send: vi.fn(async () => ({ gmailMessageId: "s", gmailThreadId: "t1" })),
  draft: vi.fn(async () => ({ gmailDraftId: "d1", gmailMessageId: "dm1", gmailThreadId: "t1" })),
  getSignature: vi.fn(async () => ""), hasDraftForThread: vi.fn(async () => false),
}) as unknown as GmailClient;
const noVoice = { getProfile: async () => null, retrieve: async () => [] };

/** Run triage with a capturing model and return the n-th prompt it was sent. */
async function triagePrompt(n: 0 | 1, msg: MailMessage, thread: ThreadMessage[] = []): Promise<string> {
  vi.mocked(gatewayComplete).mockReset();
  vi.mocked(gatewayComplete).mockResolvedValueOnce("needs_reply").mockResolvedValueOnce("Subject: Re: x\n\nok");
  await triageOneMessage({ gmail: fakeGmail(), voice: noVoice as never }, "owner@project.example", msg, thread);
  return String(vi.mocked(gatewayComplete).mock.calls[n]![0]);
}

// ── the slots: every place a builder takes outside text ────────────────────────────────────
interface Slot { name: string; build: (payload: string) => string | Promise<string> }

const followup = (over: (p: string) => Partial<Parameters<typeof buildFollowupPrompt>[0]>) => (p: string) =>
  buildFollowupPrompt({
    title: "Weekly sync", whenIso: "2026-10-14T09:00:00Z", summaryBlock: "Short recap.", actionItems: ["Send the notes"],
    recipients: ["a@example.com"], lang: "en", voiceBlock: "", ...over(p),
  });

const captureLlm = () => { const seen: string[] = []; return { seen, llm: async (prompt: string) => { seen.push(prompt); return "{}"; } }; };

const SLOTS: Slot[] = [
  { name: "meeting follow-up: title", build: followup((p) => ({ title: p })) },
  { name: "meeting follow-up: summary", build: followup((p) => ({ summaryBlock: p })) },
  { name: "meeting follow-up: action item", build: followup((p) => ({ actionItems: [p] })) },
  { name: "digest classifier: note body", build: async (p) => { const c = captureLlm(); await classifyItem({ path: "n/x.md", body: p }, { projects: [], noteNames: [] }, c.llm); return c.seen[0]!; } },
  { name: "digest article classifier: page text", build: async (p) => { const c = captureLlm(); await classifyArticle({ title: "T", url: "https://example.com", ownerNote: "", text: p }, { noteNames: [] }, c.llm); return c.seen[0]!; } },
  { name: "travelContextBlock: row title", build: (p) => travelContextBlock([meeting(p, "lodging")], "UTC") },
  { name: "conflictsBlock: mail evidence sentence", build: (p) => conflictsBlock([conflict({ resolution: { staleEventId: "e1", strength: "strong", sentence: p } })]) },
  { name: "deadlinesBlock: deadline title", build: (p) => deadlinesBlock([deadline({ title: p })], [], "en") },
  { name: "deadlinesBlock: candidate subject", build: (p) => deadlinesBlock([], [{ threadId: "th1", subject: p, sender: "x@example.com" }], "en") },
  { name: "signalsBlock: title", build: (p) => signalsBlock([signal(p)]) },
  { name: "morning brief: travel row title", build: (p) => buildMorningPrompt(brief({ meetings: [meeting(p, "lodging")] }), [], [], null, { tz: "UTC" }) },
  { name: "morning brief: deadline title", build: (p) => buildMorningPrompt(brief({ deadlines: [deadline({ title: p })] }), [], [], null, { tz: "UTC" }) },
  { name: "morning brief: signal title", build: (p) => buildMorningPrompt(brief({ signals: [signal(p)] }), [], [], null, { tz: "UTC" }) },
  { name: "evening brief: travel row title", build: (p) => buildEveningPrompt(brief({ meetings: [meeting(p, "lodging")] }), [], [], { tz: "UTC" }) },
  { name: "triage reply prompt: thread so far", build: (p) => triagePrompt(1, mail(), [threadMsg({ bodyText: p })]) },
  { name: "triage classify prompt: mail body", build: (p) => triagePrompt(0, mail({ bodyText: p })) },
  { name: "triage classify prompt: subject", build: (p) => triagePrompt(0, mail({ subject: p })) },
  { name: "triage reply prompt: original body", build: (p) => triagePrompt(1, mail({ bodyText: p })) },
  { name: "reply prompt: original body", build: (p) => replyWith({ body: p }) },
  { name: "reply prompt: original subject", build: (p) => replyWith({ subject: p }) },
  { name: "morning brief: meeting title", build: (p) => buildMorningPrompt(brief({ meetings: [meeting(p, "in-person")] }), [], [], null, { tz: "UTC" }) },
  { name: "morning brief: obligation subject", build: (p) => buildMorningPrompt(brief({ obligations: [obligation(p)] }), [], [], null, { tz: "UTC" }) },
  { name: "morning brief: ingested pick title", build: (p) => buildMorningPrompt(brief({ picks: [{ title: p, path: "a.md", created: "2026-10-14" }] }), [], [], null, { tz: "UTC" }) },
  { name: "evening brief: meeting title", build: (p) => buildEveningPrompt(brief({ meetings: [meeting(p, "in-person")] }), [], [], { tz: "UTC" }) },
  { name: "evening brief: obligation subject", build: (p) => buildEveningPrompt(brief({ obligations: [obligation(p)] }), [], [], { tz: "UTC" }) },
  { name: "conflictsBlock without mail evidence: explanation", build: (p) => conflictsBlock([conflict({ explanation: p })]) },
  { name: "digest article classifier: title and link (title)", build: async (p) => { const c = captureLlm(); await classifyArticle({ title: p, url: "https://example.com", ownerNote: "", text: "x" }, { noteNames: [] }, c.llm); return c.seen[0]!; } },
  { name: "digest article classifier: title and link (url)", build: async (p) => { const c = captureLlm(); await classifyArticle({ title: "T", url: p, ownerNote: "", text: "x" }, { noteNames: [] }, c.llm); return c.seen[0]!; } },
  { name: "meeting follow-up: recipients", build: followup((p) => ({ recipients: [p] })) },
];
function replyWith(original: Partial<{ from: string; subject: string; body: string }>): string {
  return buildReplyPrompt({
    account: "owner@project.example", lang: "en", voiceBlock: "", examples: [], contextBlocks: "", closing: "End with a short closing.",
    original: { from: "p@example.com", subject: "Question", body: "Hi", ...original },
  });
}

// ── the assertion ───────────────────────────────────────────────────────────────────────────
function assertQuarantined(prompt: string, c: InjectionCase): void {
  const payload = neutraliseHeadings(c.text);
  const at = prompt.indexOf(payload);
  expect(at, "the payload reaches the prompt").toBeGreaterThanOrEqual(0);

  // 1. the nearest heading above the payload carries the standing sentence on its next line
  const before = prompt.slice(0, at);
  const headingAt = before.startsWith("## ") ? 0 : before.lastIndexOf("\n## ") + 1;
  expect(headingAt > 0 || before.startsWith("## "), "the payload sits under a block heading").toBe(true);
  const afterHeading = before.slice(before.indexOf("\n", headingAt) + 1);
  expect(afterHeading.startsWith(`${THIRD_PARTY_NOTICE}\n`), "the heading is flagged third-party").toBe(true);
  // ...and nothing but the block's own content lies between that sentence and the payload
  const between = afterHeading.slice(THIRD_PARTY_NOTICE.length + 1);
  expect(between.includes("\n\n"), "no instruction text between the flagged heading and the payload").toBe(false);

  // 2. + 3. the instruction half: the prompt with the payload cut out
  const instructionHalf = before + prompt.slice(at + payload.length);
  expect(instructionHalf).toContain(THIRD_PARTY_NOTICE);
  expect(instructionHalf).not.toContain(c.marker);
}

describe("injection corpus through the pure prompt builders", () => {
  beforeEach(() => vi.mocked(gatewayComplete).mockReset());

  for (const slot of SLOTS) {
    describe(slot.name, () => {
      it.each(corpus)("$id stays inside a flagged block", async (c) => {
        assertQuarantined(await slot.build(c.text), c);
      });
    });
  }
});
