// The Integrations grid: one card per shared service the installation can use. The words on a card
// are fixed here; whether it is "Enabled" always comes from the same data the details page reads.
import type { ConnectionRowDTO } from "./contracts";
import type { CredentialView } from "./credentials";
import type { Logo } from "../components/LogoTile";

export type CardStatus = "enabled" | "available" | "unavailable";
export interface IntegrationCard { id: string; name: string; line: string; logo: Logo; status: CardStatus; href: string }

interface Entry { id: string; name: string; line: string; logo: Logo; anchor: string }
const DETAILS = "/integrations/details";
/** Catalogue entries that are personal accounts live on "Your accounts", not here. */
const PERSONAL = new Set(["google", "microsoft"]);
const ENTRIES: Entry[] = [
  { id: "notion", name: "Notion", line: "Meeting notes and databases your agents read and write.", logo: { kind: "letter", text: "N" }, anchor: "connection-notion" },
  { id: "twenty", name: "Twenty CRM", line: "Keep people and conversations in your CRM.", logo: { kind: "letter", text: "20" }, anchor: "connection-twenty" },
  { id: "slack", name: "Slack (bot)", line: "Agents answer and post in your Slack.", logo: { kind: "letter", text: "S" }, anchor: "connection-slack" },
  { id: "telegram", name: "Telegram (bot)", line: "Talk to your agents from Telegram.", logo: { kind: "letter", text: "T" }, anchor: "connection-telegram" },
  { id: "karakeep", name: "Karakeep", line: "Bookmarks your agents can read.", logo: { kind: "letter", text: "K" }, anchor: "connection-karakeep" },
  { id: "readability", name: "Readability worker", line: "Turns saved links into clean text.", logo: { kind: "icon", name: "readability" }, anchor: "connection-readability" },
  { id: "gateway", name: "Model gateway", line: "Where your agents' AI model calls go.", logo: { kind: "icon", name: "gateway" }, anchor: "connection-gateway" },
  { id: "signals", name: "Signal spine", line: "Brings signals from your sources into one feed.", logo: { kind: "icon", name: "signals" }, anchor: "connection-signals" },
  { id: "outside", name: "Outside tools (MCP)", line: "Add tools from servers outside Lares.", logo: { kind: "icon", name: "outside" }, anchor: "outside-tools" },
];

/** A connection counts as in use when it has recorded use, agent access or a stored account: the
 *  test the details page uses to put it above "Other connections", except that a status the console
 *  could not read is not taken as use. */
export function isActiveRow(r: ConnectionRowDTO): boolean {
  return r.status !== "unknown" && r.status !== "unavailable" || r.usedBy.length > 0 || r.accounts.length > 0;
}

export function buildIntegrationCards(input: { rows: ConnectionRowDTO[]; credential: CredentialView; outsideToolsInUse: boolean | null }): IntegrationCard[] {
  const known = new Set(input.rows.map(r => r.connectionId));
  return ENTRIES.filter(e => e.id === "outside" || (known.has(e.id) && !PERSONAL.has(e.id))).map(e => {
    const rows = input.rows.filter(r => r.connectionId === e.id);
    let status: CardStatus;
    if (e.id === "outside") status = input.outsideToolsInUse === true ? "enabled" : "available";
    else if (e.id === "notion" && input.credential.kind === "status" && input.credential.status.state === "applied") status = "enabled";
    else if (rows.some(isActiveRow)) status = "enabled";
    else if (rows.length > 0 && rows.every(r => r.status === "unavailable")) status = "unavailable";
    else status = "available";
    return { id: e.id, name: e.name, line: e.line, logo: e.logo, status, href: `${DETAILS}#${e.anchor}` };
  });
}
