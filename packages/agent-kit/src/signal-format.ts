/**
 * One anatomy, one palette, for every operational message in the fleet — the spine's Slack
 * consumer and the agents' own door messages render through this file, which is what makes an
 * alert from GCP and a card from Saga read as siblings (spec 2026-09-04 §6).
 *
 *   1  <icon> *<Project> · <title>*                 the only bold line
 *   2  <description>                                 omitted when none (never for events)
 *   3  First HH:MM · N× · last HH:MM · ORB-1 · note · <url|details>   parts omitted when absent
 *   4  _<source> · <type>_
 *
 * Times are Slack date tokens (`<!date^…^{time}|HH:MM UTC>`), so every reader sees their own
 * local time; the fallback inside the token is UTC. The card is sent as top-level Block Kit
 * blocks — NOT as a coloured attachment: Slack renders `text` AND an attachment, which showed
 * every card twice (seen 2026-09-05); with blocks present, `text` is the notification preview
 * only. The icon alone carries the colour. Nothing here may pick another emoji.
 */
export type ViewState = "error" | "warn" | "info" | "recovered" | "report";
export const PALETTE: Record<ViewState, { icon: string; color: string }> = {
  error: { icon: "🔴", color: "#d1242f" },
  warn: { icon: "🟠", color: "#e5900b" },
  info: { icon: "⚪", color: "#9a9a9a" },
  recovered: { icon: "🟢", color: "#1f9d55" },
  report: { icon: "🔵", color: "#2f6feb" },
};

// Slack caps a Block Kit section's text at 3000 chars; a wide report (many sections) can exceed
// it. The plain `text` return stays complete — the client falls back to it on msg_too_long — so
// only the section block's text is capped, here, below Slack's limit.
export const SECTION_TEXT_MAX = 2900;
/** Room reserved inside SECTION_TEXT_MAX for the "N more rows not shown" tail. */
const OVERFLOW_TAIL_BUDGET = 80;

/**
 * Cap the section block by WHOLE LINES, not characters.
 *
 * A report is one line per section (see `formatSignal`), so a character cut lands mid-row and the
 * reader cannot tell a truncated value from a real one. Keeping whole rows and saying how many are
 * missing is the honest version: a card that admits it is incomplete beats one that stops
 * mid-sentence. The dropped rows are genuinely not visible in Slack — the complete text goes out
 * as the message's `text`, which is the notification preview and the plain-text fallback, not
 * something a reader can open — so the tail promises nothing but the count.
 *
 * If ever a report routinely overflows, the real fix is several section blocks (Slack allows 50),
 * not a bigger cap. That changes the block/`text` arithmetic below and is deliberately not done here.
 */
export function capSection(lines: string[]): string {
  const joined = lines.join("\n");
  if (joined.length <= SECTION_TEXT_MAX) return joined;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = kept.length === 0 ? line.length : used + 1 + line.length;
    if (next > SECTION_TEXT_MAX - OVERFLOW_TAIL_BUDGET) break;
    kept.push(line);
    used = next;
  }
  // A single line over budget on its own leaves nothing whole to keep; a card that is only a
  // footnote is worse than a truncated one, so fall back to the character cut for that case.
  if (kept.length === 0) return `${joined.slice(0, SECTION_TEXT_MAX - 1)}…`;
  const dropped = lines.length - kept.length;
  return `${kept.join("\n")}\n_… ${dropped} more row${dropped === 1 ? "" : "s"} not shown_`;
}

export interface SignalView {
  kind: "alert" | "event" | "report";
  state: ViewState;
  project: string;
  title: string;
  description: string | null;
  url: string | null;
  firstSeen: Date;
  lastSeen: Date;
  count: number;
  linearRef: string | null;
  source: string;
  type: string;
  sections: { label: string; value: string }[];
  links: { label: string; url: string }[];
  note?: string;
}

export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
/** Slack renders this in the viewer's local time; the fallback (UTC) shows anywhere else. */
export const slackTime = (d: Date) => `<!date^${Math.floor(d.getTime() / 1000)}^{time}|${hhmm(d)} UTC>`;

function statusLine(v: SignalView): string {
  const parts = [`First ${slackTime(v.firstSeen)}`];
  if (v.count > 1) { parts.push(`${v.count}×`); parts.push(`last ${slackTime(v.lastSeen)}`); }
  if (v.linearRef) parts.push(escapeSlack(v.linearRef));
  if (v.note) parts.push(escapeSlack(v.note));
  if (v.url) parts.push(`<${v.url}|details>`);
  return parts.join(" · ");
}

export function formatSignal(v: SignalView): { text: string; blocks: unknown[] } {
  const { icon } = PALETTE[v.state];
  const head = `${icon} *${escapeSlack(v.project)} · ${escapeSlack(v.title)}*`;
  const foot = `_${escapeSlack(v.source)} · ${escapeSlack(v.type)}_`;
  let lines: string[];
  if (v.kind === "event") {
    lines = [head, foot];
  } else if (v.kind === "report") {
    // ORB-239: ONE ROW PER SECTION. These used to be joined with " · " onto a single line, which
    // is fine for two sections and an unreadable run-on for five — and every report the fleet is
    // about to send has four or five. The label is NOT bolded: this file's header states that the
    // title is the only bold line, and five competing bold labels would cost the card its one
    // visual anchor. A label that wants punctuation can carry it; that is the emitter's business.
    const rows = v.sections.map((s) => `${escapeSlack(s.label)} ${escapeSlack(s.value)}`);
    // Links stay on ONE line: they are a footer, not content, and one per line wastes the card.
    const links = v.links.map((l) => `<${l.url}|${escapeSlack(l.label)}>`).join(" · ");
    lines = [head, ...(v.description ? [escapeSlack(v.description)] : []), ...rows, ...(links ? [links] : []), foot];
  } else {
    lines = [head, ...(v.description ? [escapeSlack(v.description)] : []), statusLine(v), foot];
  }
  const text = lines.join("\n");
  // Top-level blocks: the section carries lines 1..n-1 (capped below Slack's limit), the
  // context line carries the source · type footer. Same lines as `text`, so they never drift.
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: capSection(lines.slice(0, -1)) } },
    { type: "context", elements: [{ type: "mrkdwn", text: lines[lines.length - 1] }] },
  ];
  return { text, blocks };
}

export function formatRepeatReply(at: Date): string {
  return `${slackTime(at)} · again`;
}

export function formatRecoveryReply(openedAt: Date, recoveredAt: Date): string {
  const min = Math.max(0, Math.round((recoveredAt.getTime() - openedAt.getTime()) / 60000));
  const h = Math.floor(min / 60), m = min % 60;
  return `${PALETTE.recovered.icon} recovered after ${h > 0 ? `${h} h ${m} min` : `${m} min`}`;
}
