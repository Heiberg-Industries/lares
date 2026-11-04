/**
 * What a scheduled job may touch in the Vault, by name. A schedule is not a model and has no card to
 * approve: keeper lets it act only where THIS table names the schedule, the area and the path, and only
 * when the agent's own definition also grants the area (a write needs a write grant). A path outside
 * the schedule's own rules is refused, however the request was built.
 *
 * Pure data and checks. Shared by keeper (which enforces it) and the agent side (which refuses early).
 */

export type ScheduledVaultArea = "private" | "shared";
export type ScheduledVaultOperation = "list" | "read" | "write" | "move" | "remove";

export interface ScheduledVaultRule {
  area: ScheduledVaultArea;
  /** Folders a listing may be taken under, each ending in "/". */
  listPrefixes: readonly string[];
  read: RegExp;
  write: RegExp;
  remove: RegExp;
}

const NEVER = /^(?!)/;

/** Every path the policy accepts: relative, no traversal, no hidden segment, no control characters. */
export function plainVaultPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 512 && !path.startsWith("/") &&
    !/[\\\x00-\x1f\x7f]/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."));
}

export const SCHEDULED_VAULT_POLICY: Readonly<Record<string, readonly ScheduledVaultRule[]>> = {
  // The nightly cycle: finds its cursor in its own dated notes, reads old conversation logs, writes one dated note.
  dream: [{
    area: "private",
    listPrefixes: ["_meta/dream/", "_meta/conversations/"],
    read: /^_meta\/(?:dream|conversations)\/(?:[^/]+\/)*[^/]+\.md$/,
    write: /^_meta\/dream\/\d{4}-\d{2}-\d{2}\.md$/,
    remove: NEVER,
  }],
  // The clipping drain: saves saved links into the inbox, replaces a clip when it changes, drops one that was trashed.
  "clipping-requests": [{
    area: "private",
    listPrefixes: ["_inbox/"],
    read: /^_inbox\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    write: /^_inbox\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    remove: /^_inbox\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
  }],
};

export function isScheduledVaultSchedule(name: unknown): name is string {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(SCHEDULED_VAULT_POLICY, name);
}

export function scheduledVaultRule(schedule: string, area: unknown): ScheduledVaultRule | undefined {
  return isScheduledVaultSchedule(schedule) ? SCHEDULED_VAULT_POLICY[schedule]!.find((rule) => rule.area === area) : undefined;
}

export function scheduledPathAllowed(rule: ScheduledVaultRule, operation: "read" | "write" | "remove", path: unknown): boolean {
  return plainVaultPath(path) && rule[operation].test(path);
}

export function scheduledPrefixAllowed(rule: ScheduledVaultRule, prefix: unknown): prefix is string {
  return typeof prefix === "string" && rule.listPrefixes.includes(prefix);
}

/** A note body in one frame is 256 KB shared with the envelope; the rest is for the frame itself. */
export const SCHEDULED_VAULT_MAX_BODY_BYTES = 192 * 1024;
export const SCHEDULED_VAULT_LIST_DEFAULT = 200;
export const SCHEDULED_VAULT_LIST_MAX = 500;
/** One commit message: a single line, bounded. */
export const scheduledMessageOk = (message: unknown): message is string =>
  typeof message === "string" && message.length > 0 && message.length <= 200 && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(message);
