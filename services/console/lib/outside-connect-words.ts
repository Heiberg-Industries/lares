/**
 * The placeholder tool a connection carries between "ask the server what it offers" and "the owner has
 * chosen". It is replaced before anything is reviewed, accepted or activated; it is never offered to a
 * person as a real tool.
 */
export const PENDING_TOOL = "connect-pending";

/** A short connection name from the server address ("https://mcp.example.org/api" gives "example"), or "" when none fits. */
export function suggestConnectionName(address: string): string {
  let host: string;
  try { host = new URL(address.trim()).hostname.toLowerCase(); } catch { return ""; }
  const labels = host.split(".").filter(Boolean);
  const skip = new Set(["www", "mcp", "api", "app", "mcp-server"]);
  const meaningful = labels.slice(0, Math.max(1, labels.length - 1)).filter(l => !skip.has(l));
  const word = (meaningful[meaningful.length - 1] ?? labels[0] ?? "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = /^[a-z]/.test(word) ? word : word ? `t-${word}` : "";
  return name.length >= 2 ? name.slice(0, 31).replace(/-+$/g, "") : "";
}

/** Splits "a, b  c" into the tool names it holds, once each. */
export function toolNamesOf(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map(t => t.trim()).filter(Boolean))];
}
