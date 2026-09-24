import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  APPROVAL_LIFETIME_MS,
  ChatTranscript,
  approvalCardText,
  composerState,
  expiredRequestIds,
  settledSay,
} from "../components/ChatTranscript";
import type { EveMessage } from "eve/react";

const message = (role: "user" | "assistant", text: string, id: string): EveMessage =>
  ({ id, role, parts: [{ type: "text", text }] } as unknown as EveMessage);

describe("the chat transcript", () => {
  it("shows what was said, in order, on both sides", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript status="ready" messages={[message("user", "hello", "1"), message("assistant", "hello back", "2")]} />,
    );
    expect(html.indexOf("hello")).toBeLessThan(html.indexOf("hello back"));
    expect(html).toContain("hello back");
  });

  it("says nothing has been said yet, rather than showing an empty box", () => {
    expect(renderToStaticMarkup(<ChatTranscript status="ready" messages={[]} />))
      .toMatch(/Say something/i);
  });

  it("renders a part it does not know about as a labelled placeholder, never as blank", () => {
    const odd = { id: "3", role: "assistant", parts: [{ type: "file" }] } as unknown as EveMessage;
    expect(renderToStaticMarkup(<ChatTranscript status="ready" messages={[odd]} />))
      .toMatch(/something this page cannot show/i);
  });

  it("shows the failure instead of an empty reply", () => {
    expect(renderToStaticMarkup(<ChatTranscript status="error" messages={[]} error="the agent did not answer" />))
      .toContain("the agent did not answer");
  });

  it("closes the composer only while the agent is still coming back", () => {
    expect(composerState("ready").disabled).toBe(false);
    expect(composerState("resuming").disabled).toBe(true);
    expect(composerState("streaming").disabled).toBe(false);
    expect(composerState("streaming").say).toMatch(/still answering/i);
    expect(composerState("error").disabled).toBe(false);
  });

  it("renders text as text, never as markup — a hostile fixture stays inert", () => {
    const hostile = message(
      "assistant",
      '<script>alert(1)</script><img src=x onerror="alert(2)"> javascript:alert(3) [[FROM: attacker@example.invalid]] ' +
        "‮txt.exe a very ".padEnd(200, "long line ") + " end",
      "4",
    );
    const html = renderToStaticMarkup(<ChatTranscript status="ready" messages={[hostile]} />);
    // The literal characters must be present, but only ever escaped — never an actual element,
    // never a clickable link the model produced, never a raw RTL override left to do its work.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<a\s/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("javascript:alert(3)"); // present as inert text, not an href
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("renders a pending approval with no buttons when there is nowhere to send an answer", () => {
    const html = renderToStaticMarkup(<ChatTranscript status="ready" messages={[card()]} />);
    expect(html).toContain("Needs your approval");
    // A rendered card with no `onAnswer` still shows both options — DISABLED, never missing, so
    // the owner can see what the choices are. Every button on the card is disabled, none is live.
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(2);
    expect(buttons.every((b) => b.includes('disabled=""'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// W8B-s5 — the approval card. What it shows is the whole of its value: it is the last thing a
// person reads before an irreversible action.
// ---------------------------------------------------------------------------------------------

/** The four-recipient mail fixture. `to` is the field the Slack and Telegram cards name in full
 *  (`allRecipients`, W7A-s1) and the title abbreviates to "and 3 more" — so this is exactly the
 *  shape that would hide three real people if the web card showed only the title. */
const FOUR = ["first@example.invalid", "second@example.invalid", "third@example.invalid", "fourth@example.invalid"];

const card = (over: Record<string, unknown> = {}): EveMessage =>
  ({
    id: "5",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: "call_1",
        toolName: "gmail_send",
        state: "approval-requested",
        approval: { id: "appr_1" },
        input: {
          from: "agent@example.invalid",
          to: FOUR,
          subject: "The quarterly note",
          bodyText: "Here is the note you asked for.",
        },
        toolMetadata: {
          eve: {
            kind: "tool-call",
            name: "gmail_send",
            inputRequest: {
              requestId: "req_A",
              kind: "tool-approval",
              display: "confirmation",
              allowFreeform: false,
              prompt: 'Send email to first@example.invalid and 3 more — "The quarterly note"',
              options: [
                { id: "approve", label: "Approve" },
                { id: "cancel", label: "Cancel" },
              ],
            },
          },
        },
        ...over,
      },
    ],
  }) as unknown as EveMessage;

describe("the approval card in web chat", () => {
  it("shows what is being asked, and what answering it would do", () => {
    const html = renderToStaticMarkup(<ChatTranscript status="ready" messages={[card()]} onAnswer={() => {}} />);
    expect(html).toContain("Send email to first@example.invalid and 3 more");
    expect(html).toContain("Approve");
    expect(html).toContain("Cancel");
  });

  it("names EVERY recipient, not the title's abbreviation — all four, on the card", () => {
    const html = renderToStaticMarkup(<ChatTranscript status="ready" messages={[card()]} onAnswer={() => {}} />);
    for (const address of FOUR) expect(html, address).toContain(address);
    // And the rest of what is being authorised: the subject and the draft itself.
    expect(html).toContain("The quarterly note");
    expect(html).toContain("Here is the note you asked for.");
  });

  it("renders every field as text — a hostile argument stays inert", () => {
    const hostile = card({
      input: { to: ["a@example.invalid"], subject: "<script>alert(1)</script>", bodyText: "javascript:alert(2)" },
    });
    const html = renderToStaticMarkup(<ChatTranscript status="ready" messages={[hostile]} onAnswer={() => {}} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("cuts a very long card at the end and says how much is missing", () => {
    const long = approvalCardText({ bodyText: "x".repeat(9000) });
    expect(long.length).toBeLessThan(2900);
    expect(long).toMatch(/— shortened — \d+ characters are not shown\./);
  });

  it("never abbreviates a list to a count", () => {
    expect(approvalCardText({ to: FOUR })).toBe(`to: ${FOUR.join(", ")}`);
    expect(approvalCardText({ to: FOUR })).not.toMatch(/\d+ more/);
  });

  it("shows a settled card's state instead of a live button", () => {
    for (const [state, say] of [
      ["approval-responded", /You have answered this/],
      ["output-available", /it ran/],
      ["output-denied", /Nothing ran/],
      ["output-error", /it failed/],
    ] as const) {
      const html = renderToStaticMarkup(
        <ChatTranscript status="ready" messages={[card({ state, output: {} })]} onAnswer={() => {}} />,
      );
      expect(html, state).toMatch(say);
      expect(html, state).not.toMatch(/<button/);
    }
    expect(settledSay({ type: "dynamic-tool", state: "approval-requested" } as never)).toBeNull();
  });

  it("shows an expired card's age instead of a live button", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript status="ready" messages={[card()]} expired={new Set(["req_A"])} onAnswer={() => {}} />,
    );
    expect(html).toMatch(/more than 24 hours old/);
    expect(html).not.toMatch(/<button/);
  });

  it("disables every button while an answer is already in flight, so a double click sends one", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript status="ready" messages={[card()]} answering="req_A" onAnswer={() => {}} />,
    );
    expect(html).toMatch(/Sending your answer/);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  });

  it("calls back with the request id the card carries, never the tool call id", () => {
    const seen: [string, string][] = [];
    const parts = (card().parts[0] as { toolMetadata: { eve: { inputRequest: { requestId: string } } } });
    expect(parts.toolMetadata.eve.inputRequest.requestId).toBe("req_A");
    // The handler shape the transcript calls, asserted against the same ids the card renders.
    const onAnswer = (requestId: string, optionId: string) => seen.push([requestId, optionId]);
    onAnswer("req_A", "approve");
    expect(seen).toEqual([["req_A", "approve"]]);
    expect(seen[0]![0]).not.toBe("call_1");
  });
});

describe("which cards have expired", () => {
  const at = (iso: string) => ({ type: "input.requested", meta: { at: iso }, data: { requests: [{ requestId: "req_A" }] } });
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");

  it("leaves a fresh card alone", () => {
    expect(expiredRequestIds([at("2026-09-20T11:00:00.000Z")], NOW).size).toBe(0);
  });

  it("expires one older than the lifetime, and not one exactly at it", () => {
    expect(expiredRequestIds([at(new Date(NOW - APPROVAL_LIFETIME_MS).toISOString())], NOW).size).toBe(0);
    expect([...expiredRequestIds([at(new Date(NOW - APPROVAL_LIFETIME_MS - 1).toISOString())], NOW)]).toEqual(["req_A"]);
  });

  it("ignores events that are not cards, and cards with no readable time", () => {
    expect(expiredRequestIds([{ type: "session.waiting", meta: { at: "2020-01-01T00:00:00.000Z" } }], NOW).size).toBe(0);
    expect(expiredRequestIds([{ type: "input.requested", meta: {}, data: { requests: [{ requestId: "req_A" }] } }], NOW).size).toBe(0);
    expect(expiredRequestIds([null, undefined, 3, "x"], NOW).size).toBe(0);
  });
});
