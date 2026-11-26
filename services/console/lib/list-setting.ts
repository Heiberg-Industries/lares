/** How the console lets a person type an agent setting that holds a list.
 *
 * Three agent settings hold a list, stored as one line of JSON text that the agents read. The console
 * shows such a setting as one box per value. This file is the whole translation, in both directions,
 * and nothing else: it changes how a value is typed, never what is stored or how an agent reads it.
 *
 * Two rules keep a save faithful to what the single text field sent:
 *   1. A list nobody changed is sent back exactly as it was loaded, character for character.
 *   2. A changed list is written the way the keeper itself stores one (`JSON.stringify`), so a value
 *      the console saved comes back out identical.
 * A stored value that is not such a list is not guessed at: it is shown in the plain text field.
 *
 * No database and no server import here: client components use it. */

/** A setting typed as plain values, or as tracks (each with a description and its closing stages). */
export type ListKind = "values" | "tracks";

/** The settings that hold a list, by the key the keeper names them with. */
export const LIST_SETTINGS: Readonly<Record<string, ListKind>> = {
  COMMERCIAL_BRANDS: "values",
  INSTITUTIONAL_SENDER_DOMAINS: "values",
  CRM_BRANDS: "tracks",
};

export interface TrackDraft {
  id: string;
  description: string;
  closingSteps: string[];
  /** Whether the stored track named its closing stages at all, even as an empty list; kept so on save. */
  namedClosingSteps: boolean;
}

export type SettingDraft =
  | { kind: "text"; text: string }
  | { kind: "values"; loaded: string[]; items: string[] }
  | { kind: "tracks"; loaded: TrackDraft[]; items: TrackDraft[] };

const blank = (text: string) => text.trim() === "";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function parse(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

/** The stored text as plain values; null when it is not a list of text values. Nothing stored is an empty list. */
export function valuesFrom(text: string | null): string[] | null {
  if (text === null || blank(text)) return [];
  const parsed = parse(text);
  return isStrings(parsed) ? parsed : null;
}

/** The stored text as tracks; null when any entry is not a track the boxes can show in full. */
export function tracksFrom(text: string | null): TrackDraft[] | null {
  if (text === null || blank(text)) return [];
  const parsed = parse(text);
  if (!Array.isArray(parsed)) return null;
  const tracks: TrackDraft[] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const { id, description, closingSteps, ...rest } = item as Record<string, unknown>;
    if (typeof id !== "string" || Object.keys(rest).length > 0) return null;
    if (description !== undefined && typeof description !== "string") return null;
    if (closingSteps !== undefined && !isStrings(closingSteps)) return null;
    tracks.push({ id, description: description ?? "", closingSteps: closingSteps ?? [], namedClosingSteps: closingSteps !== undefined });
  }
  return tracks;
}

/** Values as the stored text. Empty boxes are not values; no values at all clears the setting. */
export function valuesText(values: string[]): string {
  const kept = values.filter((value) => !blank(value));
  return kept.length ? JSON.stringify(kept) : "";
}

/** Tracks as the stored text. A track with every box empty is dropped; no tracks at all clears the setting. */
export function tracksText(tracks: TrackDraft[]): string {
  const kept = tracks
    .map((track) => ({ ...track, closingSteps: track.closingSteps.filter((step) => !blank(step)) }))
    .filter((track) => !blank(track.id) || !blank(track.description) || track.closingSteps.length > 0)
    .map((track) => ({
      id: track.id,
      description: track.description,
      ...(track.namedClosingSteps || track.closingSteps.length > 0 ? { closingSteps: track.closingSteps } : {}),
    }));
  return kept.length ? JSON.stringify(kept) : "";
}

/** What the page starts from for one setting: boxes when it is a list the boxes can show, the text field otherwise. */
export function draftOf(key: string, stored: string | null): SettingDraft {
  const kind = LIST_SETTINGS[key];
  if (kind === "values") {
    const values = valuesFrom(stored);
    if (values) return { kind, loaded: values, items: values };
  }
  if (kind === "tracks") {
    const tracks = tracksFrom(stored);
    if (tracks) return { kind, loaded: tracks, items: tracks };
  }
  return { kind: "text", text: stored ?? "" };
}

/** The text a save sends. An unchanged list goes back exactly as it was loaded. */
export function draftText(draft: SettingDraft, stored: string | null): string {
  if (draft.kind === "text") return draft.text;
  if (JSON.stringify(draft.items) === JSON.stringify(draft.loaded)) return stored ?? "";
  return draft.kind === "values" ? valuesText(draft.items) : tracksText(draft.items);
}
