import type { ReactNode } from "react";

/**
 * A small, hand-written Markdown renderer for text a model wrote. It exists so the web chat can
 * show bold, lists, links and code the way Telegram does, WITHOUT giving model output any way to
 * inject markup. The safety rule, kept on purpose:
 *
 *  - It builds React elements only. Nothing is ever turned into an HTML string, and there is no
 *    `dangerouslySetInnerHTML` anywhere. Every piece of text ends up as a React text child, which
 *    React escapes. Raw HTML in the input (`<img onerror=...>`, `<script>`) is therefore just
 *    characters on the screen.
 *  - Only a fixed set of elements can ever be produced: paragraphs, line breaks, bold, italic,
 *    inline code, code blocks, headings, lists and links. There is no image and no table.
 *  - A link is an anchor only when its address starts with `http:`, `https:` or `mailto:`. Anything
 *    else (`javascript:`, `data:`, `vbscript:`, relative paths) is shown as the literal text that
 *    was written. Bare addresses are never turned into links by themselves.
 *  - Links open in a new tab with `rel="noopener noreferrer"`.
 */

const SAFE_URL = /^(?:https?:|mailto:)/i;

/** True only for an absolute http(s) or mailto address that also parses as a URL. */
export function isSafeLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  // Control characters and whitespace inside an address are a classic way to hide a scheme.
  // eslint-disable-next-line no-control-regex
  if (!SAFE_URL.test(trimmed) || /[\u0000- \u007f]/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

const LINK = /^\[([^\]\n]+)\]\(([^\s()]+)\)/;
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Inline formatting inside one paragraph, list item or heading. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buffer = "";
  let n = 0;
  const flush = () => {
    if (buffer !== "") out.push(buffer);
    buffer = "";
  };
  const key = () => `${keyBase}.${n++}`;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push(<code key={key()} className="mono" style={{ fontSize: "0.92em" }}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    } else if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        const k = key();
        out.push(<strong key={k}>{renderInline(text.slice(i + 2, end), k)}</strong>);
        i = end + 2;
        continue;
      }
    } else if (ch === "*" || ch === "_") {
      // `_` only counts at a word edge, so snake_case_names stay as written.
      const edgeOk = ch === "*" || !isWordChar(text[i - 1]);
      const end = edgeOk ? text.indexOf(ch, i + 1) : -1;
      if (end > i + 1 && text[i + 1] !== " " && text[end - 1] !== " " && (ch === "*" || !isWordChar(text[end + 1]))) {
        flush();
        const k = key();
        out.push(<em key={k}>{renderInline(text.slice(i + 1, end), k)}</em>);
        i = end + 1;
        continue;
      }
    } else if (ch === "[") {
      const m = LINK.exec(text.slice(i));
      if (m !== null) {
        if (isSafeLinkUrl(m[2]!)) {
          flush();
          const k = key();
          out.push(
            <a key={k} href={m[2]!.trim()} target="_blank" rel="noopener noreferrer" style={{ color: "var(--signal)", textDecoration: "underline" }}>
              {renderInline(m[1]!, k)}
            </a>,
          );
        } else {
          // Not a link we allow: keep exactly what was written, as text.
          buffer += m[0];
        }
        i += m[0].length;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

/** Text with single newlines kept as line breaks. */
function renderLines(lines: readonly string[], keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${keyBase}.br${i}`} />);
    out.push(...renderInline(line, `${keyBase}.l${i}`));
  });
  return out;
}

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

const para = { margin: "0 0 8px" } as const;
const HEADING_SIZE = [17, 16, 15, 14, 14, 14] as const;

export function SafeMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const k = `b${blocks.length}`;
    if (line.trim() === "") {
      i++;
    } else if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence (or the end of a still-streaming block)
      blocks.push(
        <pre key={k} className="mono" style={{ margin: "0 0 8px", padding: "6px 10px", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", border: "1px solid var(--rule)", borderRadius: 4 }}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
    } else if (HEADING.test(line)) {
      const m = HEADING.exec(line)!;
      const level = m[1]!.length;
      blocks.push(
        <p key={k} role="heading" aria-level={Math.min(level + 2, 6)} style={{ margin: "0 0 6px", fontWeight: 600, fontSize: HEADING_SIZE[level - 1] }}>
          {renderInline(m[2]!, k)}
        </p>,
      );
      i++;
    } else if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const marker = ordered ? ORDERED : BULLET;
      const items: ReactNode[] = [];
      while (i < lines.length && marker.test(lines[i]!)) {
        items.push(<li key={`${k}.i${items.length}`}>{renderInline(marker.exec(lines[i]!)![1]!, `${k}.i${items.length}`)}</li>);
        i++;
      }
      const style = { margin: "0 0 8px", paddingLeft: 22 } as const;
      blocks.push(ordered ? <ol key={k} style={style}>{items}</ol> : <ul key={k} style={style}>{items}</ul>);
    } else {
      const chunk: string[] = [];
      while (
        i < lines.length && lines[i]!.trim() !== "" && !FENCE.test(lines[i]!) &&
        !HEADING.test(lines[i]!) && !BULLET.test(lines[i]!) && !ORDERED.test(lines[i]!)
      ) chunk.push(lines[i++]!);
      blocks.push(<p key={k} style={para}>{renderLines(chunk, k)}</p>);
    }
  }
  return <div style={{ wordBreak: "break-word" }}>{blocks}</div>;
}
