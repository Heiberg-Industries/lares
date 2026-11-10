// The plain words an integration's page uses, and which permission rows belong to which service.
import { connectionsByCapability, parseConnectionRef } from "@lares/agent-kit/connections";
import type { BoardRowDTO, ConnectionRowDTO } from "./contracts";

/** Agent ids as the member knows them: the display name, or the id itself when none is known. */
export function agentNames(ids: readonly string[], agents: readonly { name: string; displayName: string }[]): string[] {
  const names = new Map(agents.map((a) => [a.name, a.displayName]));
  return ids.map((id) => names.get(id) || id);
}

export function ago(iso: string, now = Date.now()): string {
  const mins = Math.round((now - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

export function lastUseText(r: Pick<ConnectionRowDTO, "usageUnavailable" | "lastUsed">): string {
  if (r.usageUnavailable) return "Could not be read";
  return r.lastUsed ? ago(r.lastUsed) : "Not used yet";
}

const KEPT: Record<ConnectionRowDTO["custody"], string> = {
  console: "Kept by the console on this server.",
  host: "Kept on the server. The console cannot see it; it shows only what agents report using.",
  foreign: "Kept by the other service.",
};
export const keptText = (custody: ConnectionRowDTO["custody"]): string => KEPT[custody];

/** The permission rows whose capability maps to this connection. A vault, deadline or digest row maps
 *  to none, so it never shows under Integrations; it stays on the agent's own page. */
export function boardRowsFor(connectionId: string, board: BoardRowDTO[]): BoardRowDTO[] {
  return board.filter((b) => (connectionsByCapability[b.capability] ?? []).some((ref) => parseConnectionRef(ref).connectionId === connectionId));
}
