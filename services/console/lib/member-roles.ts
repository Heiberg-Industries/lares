/** A member's stored role and status in plain words, for the Members page and the invitation form.
 *  Words only: what a role may do is decided where access is checked, never here. No server import,
 *  so a client component can use it. */
export const ROLE_WORDS: Readonly<Record<string, { name: string; meaning: string }>> = {
  owner: { name: "Owner", meaning: "Has the owner role. Only the owner who set up this installation gets the owner's pages in this console: members and roles, backups and the general settings. Anyone else with this role uses the console as a member." },
  admin: { name: "Admin", meaning: "Can see the agents and use the console's shared pages: connections, tools, activity, quiet hours and alert routing. Cannot create or edit an agent, cannot change members and roles, backups or the general settings, and cannot delete the installation's data." },
  member: { name: "Member", meaning: "Can use what is shared with everyone here, and what is shared with them by name." },
  restricted: { name: "Limited member", meaning: "Can use only what is shared with them by name, not what is shared with everyone." },
};

/** Every role a person can be given, once, in the order a form offers them. The invitation form offers
 *  all of them; the picker on the Members page offers the ones marked PICKER_ROLES. */
export const ROLE_CHOICES = ["member", "admin", "restricted", "owner"] as const;
export type RoleChoice = (typeof ROLE_CHOICES)[number];
/** The two the owner switches a person between on Members. An owner's or a limited member's role is
 *  not changed there. */
export const PICKER_ROLES = ROLE_CHOICES.filter((role): role is "member" | "admin" => role === "admin" || role === "member");
export type PickerRole = (typeof PICKER_ROLES)[number];
export const isRoleChoice = (value: unknown): value is RoleChoice => (ROLE_CHOICES as readonly unknown[]).includes(value);
export const isPickerRole = (value: unknown): value is PickerRole => (PICKER_ROLES as readonly unknown[]).includes(value);

/** The words for a role. A role this page does not know is said plainly rather than shown as its stored word. */
export function roleWords(role: string): { name: string; meaning: string } {
  return ROLE_WORDS[role] ?? { name: "Unknown role", meaning: "This kind of membership could not be read." };
}

export const STATUS_WORDS: Readonly<Record<string, { word: string; variant: "success" | "neutral" | "warning" }>> = {
  active: { word: "Active", variant: "success" },
  invited: { word: "Invited, not signed in yet", variant: "warning" },
  removed: { word: "Removed", variant: "neutral" },
};
