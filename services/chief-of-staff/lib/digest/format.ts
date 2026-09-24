import type { DigestSummary } from "./runner.js";

/** A rendered digest summary: Slack Block Kit + a text fallback + optional thread-reply detail. */
export interface DigestView {
  text: string;            // notification fallback (and the body when blocks aren't rendered)
  blocks: unknown[];       // Slack Block Kit
  errorDetail?: string;    // posted as a reply in the summary's thread (error paths never go inline)
  report: {
    title: string;
    sections: { label: string; value: string }[];
    links: { label: string; url: string }[];
  };
}

const header = (text: string) => ({ type: "header", text: { type: "plain_text", text, emoji: true } });
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const divider = () => ({ type: "divider" });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function filedBreakdown(filed: DigestSummary["filed"]): string {
  const byDest = new Map<string, number>();
  for (const f of filed) byDest.set(f.destination, (byDest.get(f.destination) ?? 0) + 1);
  return [...byDest.entries()].map(([d, n]) => `${n} ${d}`).join(" · ");
}

/**
 * Render a digest summary the way Bendik reads it: a one-line headline, then ONLY the
 * decisions that need him (each with the model's suggested destination + reason). Filed
 * notes collapse to a count; error paths go to a thread reply, never inline.
 */
export function renderDigest(s: DigestSummary): DigestView {
  const filed = s.filed.length, asked = s.asked.length, errors = s.errors.length;

  if (!filed && !asked && !errors) {
    const text = "📥 Digest · inbox clear — nothing new to file.";
    return {
      text,
      blocks: [section(text)],
      report: { title: "Digest · inbox clear — nothing new to file.", sections: [], links: [] },
    };
  }

  const headline = `📥 Digest · ${filed} filed · ${asked} need a home · ${plural(errors, "error")}`;
  const blocks: unknown[] = [header(headline)];

  if (asked) {
    blocks.push(divider());
    for (const a of s.asked) {
      const dest = a.suggestedDestination && a.suggestedDestination.length ? `\`${a.suggestedDestination}\`` : "_unsure_";
      blocks.push(section(`*${a.title}*\n→ suggests ${dest} · ${a.reason}`));
    }
  }

  if (filed) blocks.push(context(`Filed ${filedBreakdown(s.filed)}`));

  // Static pointer to the commercial radar — runs weekly (Mon 08:00) + monthly.
  blocks.push(context("📇 Commercial radar runs weekly — check #sales for who to contact & why."));

  const askLines = s.asked.map((a) => `• ${a.title}`).join("\n");
  const text = asked ? `${headline}\n${askLines}` : headline;

  const reportSections = s.asked.map((a) => ({
    label: a.title,
    value: `Suggests ${a.suggestedDestination?.length ? a.suggestedDestination : "unsure"} · ${a.reason}`,
  }));
  reportSections.push({ label: "Filed", value: filed ? filedBreakdown(s.filed) : "Nothing filed" });

  const view: DigestView = {
    text,
    blocks,
    report: {
      title: headline.replace(/^📥\s*/, ""),
      sections: reportSections,
      links: [{ label: "Commercial radar", url: "https://slack.com/app_redirect?channel=sales" }],
    },
  };
  if (errors) {
    view.errorDetail =
      `${plural(errors, "item")} errored (left in _inbox):\n` +
      s.errors.map((e) => `• ${e.path} — ${e.error}`).join("\n");
  }
  return view;
}
