import { describe, it, expect } from "vitest";
import { PALETTE, SECTION_TEXT_MAX, capSection, formatSignal, formatRepeatReply, formatRecoveryReply, slackTime, type SignalView } from "../src/signal-format.js";

const v = (over: Partial<SignalView> = {}): SignalView => ({
  kind: "alert", state: "error", project: "zero7", title: "Uptime check failed", description: "Customers cannot reach the app.",
  url: "https://console.cloud.google.com/x", firstSeen: new Date("2026-09-04T08:46:00Z"), lastSeen: new Date("2026-09-04T08:46:00Z"),
  count: 1, linearRef: null, source: "gcp-monitoring", type: "service-down", sections: [], links: [], ...over });

describe("palette", () => {
  it("five states, icon and colour agree", () => {
    expect(PALETTE.error).toEqual({ icon: "🔴", color: "#d1242f" });
    expect(PALETTE.warn.icon).toBe("🟠"); expect(PALETTE.info.icon).toBe("⚪");
    expect(PALETTE.recovered.icon).toBe("🟢"); expect(PALETTE.report.icon).toBe("🔵");
  });
});

describe("formatSignal — alert", () => {
  it("line 1 icon + bold project · title; line 2 description; line 3 status; line 4 source · type", () => {
    const { text, blocks } = formatSignal(v());
    const lines = text.split("\n");
    expect(lines[0]).toBe("🔴 *zero7 · Uptime check failed*");
    expect(lines[1]).toBe("Customers cannot reach the app.");
    expect(lines[2]).toBe(`First ${slackTime(new Date("2026-09-04T08:46:00Z"))} · <https://console.cloud.google.com/x|details>`);
    expect(lines[2]).toContain(`<!date^${Math.floor(Date.parse("2026-09-04T08:46:00Z") / 1000)}^{time}|08:46 UTC>`);
    expect(lines[3]).toBe("_gcp-monitoring · service-down_");
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { type: string }).type).toBe("section");
    expect((blocks[1] as { type: string }).type).toBe("context");
    expect(JSON.stringify(blocks)).not.toContain("color");
  });
  it("omits the description line when none; shows count, last, Linear ref and note when present", () => {
    const t = formatSignal(v({ description: null, count: 9, lastSeen: new Date("2026-09-04T13:56:00Z"), linearRef: "ORB-231", note: "not delegated (cap)" })).text;
    expect(t.split("\n")).toHaveLength(3);
    expect(t).toContain(`First ${slackTime(new Date("2026-09-04T08:46:00Z"))} · 9× · last ${slackTime(new Date("2026-09-04T13:56:00Z"))} · ORB-231 · not delegated (cap) · <https://console.cloud.google.com/x|details>`);
  });
  it("recovered state uses the green icon", () => {
    expect(formatSignal(v({ state: "recovered" })).text.startsWith("🟢 ")).toBe(true);
  });
  it("escapes Slack markup in title, project, source, description", () => {
    const t = formatSignal(v({ title: "<b> & c", description: "a > b" })).text;
    expect(t).toContain("&lt;b&gt; &amp; c"); expect(t).toContain("a &gt; b");
  });
});

describe("formatSignal — event and report", () => {
  it("event is lines 1 and 4 only, grey", () => {
    const t = formatSignal(v({ kind: "event", state: "info", description: "ignored for events" })).text;
    expect(t.split("\n")).toEqual(["⚪ *zero7 · Uptime check failed*", "_gcp-monitoring · service-down_"]);
  });
  // ORB-239. This test was NAMED "one row per section" while asserting the joined line — the
  // sections used to be `.join(" · ")`, readable at two and a run-on at five.
  it("report renders a header, one row per section, links on a single line", () => {
    const { text, blocks } = formatSignal(v({ kind: "report", state: "report", title: "Pilot · Friday 4 September",
      sections: [{ label: "Active users", value: "1" }, { label: "Messages", value: "2" }],
      links: [{ label: "Sentry", url: "https://s" }, { label: "PostHog", url: "https://p" }] }));
    expect(text.split("\n")).toEqual([
      "🔵 *zero7 · Pilot · Friday 4 September*",
      "Customers cannot reach the app.",
      "Active users 1",
      "Messages 2",
      "<https://s|Sentry> · <https://p|PostHog>",
      "_gcp-monitoring · service-down_",
    ]);
    expect(JSON.stringify(blocks)).toContain("Active users");
  });

  it("five sections render as five rows — the shape every fleet report is about to have", () => {
    const sections = ["Filed", "Needs a home", "Errors", "Drafts", "Proposals"].map((label, i) => ({ label, value: String(i) }));
    const { text } = formatSignal(v({ kind: "report", state: "report", title: "Digest", description: null, sections, links: [] }));
    expect(text.split("\n").slice(1, -1)).toEqual(["Filed 0", "Needs a home 1", "Errors 2", "Drafts 3", "Proposals 4"]);
  });

  // The file's own promise: blocks are built from the same `lines` as `text`, so they cannot drift.
  // The overflow cap is the ONE exception, and it announces itself.
  it("the block and the text carry the same lines whenever nothing overflows", () => {
    const { text, blocks } = formatSignal(v({ kind: "report", state: "report", title: "Small",
      sections: [{ label: "A", value: "1" }, { label: "B", value: "2" }], links: [] }));
    const lines = text.split("\n");
    expect((blocks[0] as { text: { text: string } }).text.text).toBe(lines.slice(0, -1).join("\n"));
    expect((blocks[1] as { elements: { text: string }[] }).elements[0].text).toBe(lines[lines.length - 1]);
  });

  it("a wide report keeps WHOLE rows and says how many it dropped; text stays complete", () => {
    const sections = Array.from({ length: 200 }, (_, i) => ({ label: `Section${i}`, value: `Value${i}` }));
    // description: null so the block is exactly header + rows + tail and the arithmetic below
    // counts rows rather than quietly including the description line.
    const { text, blocks } = formatSignal(v({ kind: "report", state: "report", title: "Long report", description: null, sections, links: [] }));
    const sectionBlockText = (blocks[0] as { text: { text: string } }).text.text;
    expect(sectionBlockText.length).toBeLessThanOrEqual(SECTION_TEXT_MAX);
    // Every kept row is whole — the last one before the tail is not cut mid-value.
    const rendered = sectionBlockText.split("\n");
    expect(rendered[rendered.length - 1]).toMatch(/^_… \d+ more rows not shown_$/);
    for (const line of rendered.slice(1, -1)) expect(line).toMatch(/^Section\d+ Value\d+$/);
    // The count is accurate: kept rows + dropped = 200 (plus the header line).
    const dropped = Number(/(\d+) more rows/.exec(rendered[rendered.length - 1])![1]);
    expect(rendered.length - 2 + dropped).toBe(sections.length);
    // And the plain text — the notification preview and the msg_too_long fallback — is untruncated.
    expect(text).toContain(`Section${sections.length - 1} Value${sections.length - 1}`);
  });

  it("one row too long to keep whole falls back to a character cut rather than a bare footnote", () => {
    const line = "x".repeat(SECTION_TEXT_MAX * 2);
    const out = capSection([line]);
    expect(out.length).toBeLessThanOrEqual(SECTION_TEXT_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("more rows not shown");
  });

  it("capSection returns the lines untouched when they fit", () => {
    expect(capSection(["a", "b", "c"])).toBe("a\nb\nc");
  });
});

describe("replies", () => {
  it("repeat reply is a Slack local-time token and 'again'", () => { expect(formatRepeatReply(new Date("2026-09-04T13:10:00Z"))).toBe(`<!date^${Math.floor(Date.parse("2026-09-04T13:10:00Z") / 1000)}^{time}|13:10 UTC> · again`); });
  it("recovery reply states the duration in h and min", () => {
    expect(formatRecoveryReply(new Date("2026-09-04T08:10:00Z"), new Date("2026-09-04T10:23:00Z"))).toBe("🟢 recovered after 2 h 13 min");
    expect(formatRecoveryReply(new Date("2026-09-04T08:10:00Z"), new Date("2026-09-04T08:15:00Z"))).toBe("🟢 recovered after 5 min");
  });
});
