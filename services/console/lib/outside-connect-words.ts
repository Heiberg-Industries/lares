/**
 * The placeholder tool a connection carries between "ask the server what it offers" and "the owner has
 * chosen". It is replaced before anything is reviewed, accepted or activated; it is never offered to a
 * person as a real tool.
 */
export const PENDING_TOOL = "connect-pending";

/**
 * A short connection name from the server address: the first label of the host that is not a common
 * prefix ("https://mcp.example.org/api" gives "example"), or "" when none fits. Always a name the keeper accepts.
 */
export function suggestConnectionName(address: string): string {
  let host: string;
  try { host = new URL(address.trim()).hostname.toLowerCase(); } catch { return ""; }
  const labels = host.split(".").filter(Boolean);
  const skip = new Set(["www", "mcp", "api", "app", "tools", "server", "mcp-server", "gateway"]);
  // The last label is the domain ending ("org", "com"); keep it only when it is all there is ("localhost").
  const candidates = labels.length > 1 ? labels.slice(0, -1) : labels;
  const word = (candidates.find(l => !skip.has(l)) ?? candidates[0] ?? "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = /^[a-z]/.test(word) ? word : word ? `t-${word}` : "";
  return name.length >= 2 ? name.slice(0, 31).replace(/-+$/g, "") : "";
}

/** The name, or the name with -2, -3 ... added when another connection already uses it. */
export function uniqueConnectionName(base: string, taken: readonly string[]): string {
  if (!base || !taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`, candidate = `${base.slice(0, 31 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return base;
}

/** Splits "a, b  c" into the tool names it holds, once each. */
export function toolNamesOf(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map(t => t.trim()).filter(Boolean))];
}

/** In a saved list, a trust entry with this pin means "bind to the description the agent has pinned now". */
export const BIND_TO_PINNED = "0".repeat(64);
