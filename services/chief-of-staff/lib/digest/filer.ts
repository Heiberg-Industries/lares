import type { DigestDecision } from "./types.js";

export type FileNoteFn = (opts: {
  destPath: string;
  sourcePath?: string;
  frontmatter: Record<string, unknown>;
  body: string;
  message: string;
}) => Promise<{ commit: string }>;

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "note";
}

export function buildNote(decision: DigestDecision, original: string, capturedAt: string) {
  const destPath = `${decision.destination}/${slugify(decision.title)}.md`;
  const frontmatter: Record<string, unknown> = {
    title: decision.title,
    type: decision.type,
    source: "digest",
    filed_by: "digest",
    captured: capturedAt,
  };
  const linkBlock = decision.links.length ? `\n\n## Related\n${decision.links.join(" ")}` : "";
  const body = `${decision.summary}${linkBlock}\n\n## Source\n${original}`;
  const message = `digest: file ${decision.title} → ${decision.destination}`;
  return { destPath, frontmatter, body, message };
}

export async function fileDecision(
  decision: DigestDecision,
  source: { path: string; body: string; capturedAt: string },
  fileNote: FileNoteFn,
): Promise<{ commit: string; destPath: string }> {
  const note = buildNote(decision, source.body, source.capturedAt);
  const { commit } = await fileNote({ ...note, sourcePath: source.path });
  return { commit, destPath: note.destPath };
}
