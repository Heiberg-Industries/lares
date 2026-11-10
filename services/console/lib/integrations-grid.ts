// The Integrations grid: one card per shared service the installation can use. The words on a card
// are fixed here; whether it is "Enabled" always comes from the same data the detail pages read.
import type { ConnectionRowDTO } from "./contracts";
import type { CredentialView } from "./credentials";
import type { Logo } from "../components/LogoTile";
import type { GatewayStatusView } from "./gateway-status";

export type CardStatus = "enabled" | "available" | "unavailable";
export interface IntegrationCard { id: string; name: string; line: string; logo: Logo; status: CardStatus; href: string }

interface Entry { id: string; name: string; line: string; logo: Logo }
export const STATUS_TEXT: Record<CardStatus, string> = { enabled: "Enabled", available: "Connect", unavailable: "Status unavailable" };
/** Catalogue entries that are personal accounts live on "Your accounts", not here. */
const PERSONAL = new Set(["google", "microsoft"]);
const ENTRIES: Entry[] = [
  { id: "notion", name: "Notion", line: "Meeting notes and databases your agents read and write.", logo: { kind: "letter", text: "N" } },
  { id: "twenty", name: "Twenty CRM", line: "Keep people and conversations in your CRM.", logo: { kind: "letter", text: "20" } },
  { id: "slack", name: "Slack (bot)", line: "Agents answer and post in your Slack.", logo: { kind: "letter", text: "S" } },
  { id: "telegram", name: "Telegram (bot)", line: "Talk to your agents from Telegram.", logo: { kind: "letter", text: "T" } },
  { id: "karakeep", name: "Karakeep", line: "Bookmarks your agents can read.", logo: { kind: "letter", text: "K" } },
  { id: "readability", name: "Readability worker", line: "Turns saved links into clean text.", logo: { kind: "icon", name: "readability" } },
  { id: "gateway", name: "Model gateway", line: "Where your agents' AI model calls go.", logo: { kind: "icon", name: "gateway" } },
  { id: "signals", name: "Signal spine", line: "Brings signals from your sources into one feed.", logo: { kind: "icon", name: "signals" } },
  { id: "outside", name: "Outside tools (MCP)", line: "Add tools from servers outside Lares.", logo: { kind: "icon", name: "outside" } },
];

/** A connection counts as in use when it has recorded use, agent access or a stored account, except
 *  that a status the console could not read is not taken as use. */
export function isActiveRow(r: ConnectionRowDTO): boolean {
  return r.status !== "unknown" && r.status !== "unavailable" || r.usedBy.length > 0 || r.accounts.length > 0;
}

export interface CardInput { rows: ConnectionRowDTO[]; credential: CredentialView; outsideToolsInUse: boolean | null; gateway: GatewayStatusView }

/** The model gateway is read from the gateway itself, not from connection rows: it is "Enabled" when it
 *  reports it is set up (any reachability but "not-configured") or an agent is set to use one of its models. */
export function gatewayAgents(view: GatewayStatusView): string[] {
  return view.kind === "status" && view.usage ? [...new Set(Object.values(view.usage).flat())].sort() : [];
}
function gatewayStatus(view: GatewayStatusView): CardStatus {
  if (view.kind !== "status") return "unavailable";
  return view.status.reachability !== "not-configured" || gatewayAgents(view).length > 0 ? "enabled" : "available";
}

function statusOf(id: string, input: CardInput): CardStatus {
  const rows = input.rows.filter(r => r.connectionId === id);
  if (id === "gateway") return gatewayStatus(input.gateway);
  if (id === "outside") return input.outsideToolsInUse === true ? "enabled" : "available";
  if (id === "notion" && input.credential.kind === "status" && input.credential.status.state === "applied") return "enabled";
  if (rows.some(isActiveRow)) return "enabled";
  if (rows.length > 0 && rows.every(r => r.status === "unavailable")) return "unavailable";
  return "available";
}

/** The card the grid shows for this id, or null when the grid would not show one. The detail page
 *  reads its name, line, logo and status from here, so the two never disagree. */
export function integrationCard(id: string, input: CardInput): IntegrationCard | null {
  const e = ENTRIES.find(x => x.id === id);
  if (!e || (e.id !== "outside" && (PERSONAL.has(e.id) || !input.rows.some(r => r.connectionId === e.id)))) return null;
  return { ...e, status: statusOf(e.id, input), href: `/integrations/${e.id}` };
}

export function buildIntegrationCards(input: CardInput): IntegrationCard[] {
  return ENTRIES.flatMap(e => integrationCard(e.id, input) ?? []);
}
