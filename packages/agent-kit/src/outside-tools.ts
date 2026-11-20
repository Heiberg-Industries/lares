// Outside tools (MCP servers the owner connected;. Pure helpers shared by the
// definition check, the keeper (egress hosts, secret mounts) and the persona. No I/O, no
// credential reads, no module-scope work: eve evaluates modules during `eve build`.
//
// The capability is `outside`. A definition lists servers under `outsideTools`; the entries do
// nothing unless the agent also holds a grant of `outside` that is not `none` and its autonomy
// for `outside` is not `never` (see `outsideToolsInEffect`).
import { isIP } from "node:net";

import type { AgentDefinition, OutsideToolDeclaration } from "./definition.js";

export const OUTSIDE_CAPABILITY = "outside";

/** How the keeper names an outside tool's token file under the secrets directory. */
export function outsideSecretName(agentName: string, toolName: string): string {
  return `${agentName}-outside-${toolName}-token`;
}

/** Where the agent's container sees that file. The engine derives it from the entry's name and
 *  never reads a fixed list of files. */
export function outsideSecretTarget(toolName: string): string {
  return `outside-${toolName}`;
}

export type OutsideUrlCheck =
  | { ok: true; scheme: "https" | "http"; host: string }
  | { ok: false; reason: string };

const PRIVATE_TLDS = new Set(["local", "localhost", "internal", "lan", "home", "corp", "intranet", "arpa", "test", "invalid", "example"]);
const PUBLIC_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** The same rules for everyone who reads an outside tool's URL. `https` needs a public hostname
 *  (never an IP address), the default port, no credentials and no fragment, exactly the keeper's
 *  `endpointHost`. `http` is accepted only for a single-label compose service name (inside the
 *  server's own network, which the egress seal already allows). */
export function checkOutsideUrl(value: string): OutsideUrlCheck {
  if (typeof value !== "string" || /[\s\\]/.test(value)) return { ok: false, reason: "the address contains spaces or backslashes" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "the address is not a valid URL" };
  }
  if (url.username || url.password) return { ok: false, reason: "the address must not contain credentials" };
  if (url.hash) return { ok: false, reason: "the address must not contain a fragment" };
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:") {
    if (url.port) return { ok: false, reason: "an https address must use port 443" };
    if (host.startsWith("[") || isIP(host) !== 0) return { ok: false, reason: "an https address must use a hostname, not an IP address" };
    const tld = host.slice(host.lastIndexOf(".") + 1);
    if (host.length > 253 || !PUBLIC_HOST_RE.test(host) || PRIVATE_TLDS.has(tld)) {
      return { ok: false, reason: "an https address must use a public hostname" };
    }
    return { ok: true, scheme: "https", host };
  }
  if (url.protocol === "http:") {
    if (host.startsWith("[") || isIP(host) !== 0 || !SERVICE_NAME_RE.test(host)) {
      return { ok: false, reason: "plain http is only allowed for a single-word service name on the box's own network" };
    }
    return { ok: true, scheme: "http", host };
  }
  return { ok: false, reason: "the address must start with https://" };
}

/** The entries that actually take effect: the agent holds a grant of `outside` (not `none`) and
 *  its autonomy for `outside` is not `never`. Anything else resolves to nothing. */
export function outsideToolsInEffect(
  d: Pick<AgentDefinition, "grants" | "autonomy" | "outsideTools">,
): OutsideToolDeclaration[] {
  const tools = d.outsideTools ?? [];
  if (tools.length === 0) return [];
  const grant = d.grants.find((g) => g.capability === OUTSIDE_CAPABILITY);
  if (!grant || grant.scope === "none") return [];
  if (d.autonomy[OUTSIDE_CAPABILITY] === "never") return [];
  return tools;
}

/** The owner's recorded trust for one tool: only a tool listed in `read` can have it. */
export function trustGrantFor(entry: Pick<OutsideToolDeclaration, "tools">, bareTool: string): NonNullable<OutsideToolDeclaration["tools"]["trusted"]>[number] | undefined {
  return entry.tools.read.includes(bareTool) ? (entry.tools.trusted ?? []).find((t) => t.tool === bareTool) : undefined;
}

/** Whether the owner lets this tool run without a card, NOW. It must be in BOTH `read` and `trusted`
 *  (a tool that changes something always asks), and the description the owner switched it on for must be
 *  the one in force (`currentPin`, from `toolPinHash`); with no current pin the answer is no. */
export function isTrustedRead(entry: Pick<OutsideToolDeclaration, "tools">, bareTool: string, currentPin: string | undefined): boolean {
  const grant = trustGrantFor(entry, bareTool);
  return grant !== undefined && currentPin !== undefined && grant.pin === currentPin;
}

/** Who and when, written by the keeper and never taken from the browser. A switch that was already on
 *  for the same tool with the same description keeps its original who and when; a new or re-ticked one
 *  is stamped with `by` and `now`. Anything else the browser sent for `by`/`at` is thrown away. */
export function stampTrust(
  next: readonly OutsideToolDeclaration[],
  previous: readonly OutsideToolDeclaration[],
  by: string,
  now: string,
): OutsideToolDeclaration[] {
  return next.map((entry) => {
    const trusted = entry.tools.trusted;
    if (trusted === undefined) return entry;
    const before = previous.find((p) => p.name === entry.name)?.tools.trusted ?? [];
    const stamped = trusted.map((t) => {
      const kept = before.find((b) => b.tool === t.tool && b.pin === t.pin);
      return kept ?? { tool: t.tool, pin: t.pin, by, at: now };
    });
    return { ...entry, tools: { ...entry.tools, trusted: stamped } };
  });
}

/** The https hostnames the keeper must open in the proxy for these entries. Internal http
 *  service names add nothing (the internal networks are already reachable). An entry whose URL
 *  fails the check is skipped here; the definition check refuses it at save. */
export function outsideHttpsHosts(tools: readonly Pick<OutsideToolDeclaration, "url">[]): string[] {
  const hosts = new Set<string>();
  for (const t of tools) {
    const c = checkOutsideUrl(t.url);
    if (c.ok && c.scheme === "https") hosts.add(c.host);
  }
  return [...hosts].sort();
}
