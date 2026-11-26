/** A member's stored role and status in plain words, for the Members page and the invitation form.
 *  Words only: what a role may do is decided where access is checked, never here. No server import,
 *  so a client component can use it. */
export const ROLE_WORDS: Readonly<Record<string, { name: string; meaning: string }>> = {
  owner: { name: "Owner", meaning: "Has the owner role. Only the owner who set up this installation can open the owner console." },
  member: { name: "Member", meaning: "Can use what is shared with everyone here, and what is shared with them by name." },
  restricted: { name: "Limited member", meaning: "Can use only what is shared with them by name, not what is shared with everyone." },
};

/** The words for a role. A role this page does not know is said plainly rather than shown as its stored word. */
export function roleWords(role: string): { name: string; meaning: string } {
  return ROLE_WORDS[role] ?? { name: "Unknown role", meaning: "This kind of membership could not be read." };
}

export const STATUS_WORDS: Readonly<Record<string, { word: string; variant: "success" | "neutral" | "warning" }>> = {
  active: { word: "Active", variant: "success" },
  invited: { word: "Invited, not signed in yet", variant: "warning" },
  removed: { word: "Removed", variant: "neutral" },
};
