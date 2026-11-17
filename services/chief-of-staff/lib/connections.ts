/**
 * lib/connections.ts: which outside services this installation is actually connected to, read
 * from real state, and the short prompt block that tells the chief of staff so.
 *
 * WHY. The persona lists every capability the definition declares. On a fresh install with only
 * web chat and Telegram, "what can you do" then listed a CRM, Notion, Atlas and outreach that
 * nothing was connected to, and a missing Google connection was called "a setup fault on my
 * side". The model has no way to tell declared from connected, so it is told, per session.
 *
 * Each probe is cheap and answers "is it connected", never "is it healthy". A probe that cannot
 * decide (database down, timeout) counts as NOT connected: the prompt then says "not connected"
 * rather than inventing a capability, and the next session asks again.
 */
import { existsSync } from "node:fs";

import { storeRoot } from "@lares/agent-kit/notes-store";

import { listEnrolledMailboxes } from "./google.js";
import { allowedSlackUserIds } from "@lares/agent-kit/principals";
import { withTimeout } from "./timeout.js";

export type ConnectionKey = "google" | "crm" | "notion" | "vault" | "atlas" | "slack";

export type ConnectionState = Record<ConnectionKey, boolean>;

/** What each connection unlocks, in the owner's words. Order is the order they are listed in. */
const LABELS: Record<ConnectionKey, string> = {
  google: "Google (mail and calendar)",
  crm: "the CRM (Twenty), including outreach follow-up",
  notion: "Notion",
  vault: "the personal vault of notes",
  atlas: "the shared business vault (Atlas)",
  slack: "Slack",
};

const KEYS = Object.keys(LABELS) as ConnectionKey[];

const PROBE_TIMEOUT_MS = 4_000;

export interface ConnectionProbes {
  google(): Promise<boolean>;
  env: NodeJS.ProcessEnv;
  fileExists(path: string): boolean;
  slackUsers(): readonly string[];
}

const liveProbes: ConnectionProbes = {
  google: async () => (await withTimeout(listEnrolledMailboxes(), PROBE_TIMEOUT_MS, "connections: google")).length > 0,
  env: process.env,
  fileExists: existsSync,
  slackUsers: allowedSlackUserIds,
};

function storeConfigured(store: "brain" | "atlas", env: NodeJS.ProcessEnv): boolean {
  try {
    storeRoot(store, env);
    return true;
  } catch {
    return false;
  }
}

/** Whether the CRM is connected: its base URL is set and its key file exists. No network call and
 *  the key is never read. The one decision, used by the full list and by the shared-room line. */
function crmConnected(env: NodeJS.ProcessEnv, fileExists: (path: string) => boolean): boolean {
  return Boolean(env["TWENTY_BASE_URL"]?.trim()) && fileExists(env["TWENTY_KEY_FILE"] ?? "/run/secrets/twenty-key");
}

export async function readConnections(probes: ConnectionProbes = liveProbes): Promise<ConnectionState> {
  const { env } = probes;
  const google = await probes.google().catch(() => false);
  return {
    google,
    crm: crmConnected(env, probes.fileExists),
    notion: Boolean(env["NOTION_TOKEN"]?.trim()) || Boolean(env["NOTION_TOKEN_FILE"]?.trim()),
    vault: storeConfigured("brain", env),
    atlas: storeConfigured("atlas", env),
    slack: probes.slackUsers().length > 0,
  };
}

/** The only connection text a conversation started in a shared room gets: whether contacts are
 *  connected, and nothing about any other service. Everyone in the channel reads the answers, and
 *  the full list names the owner's services. Without this line the contact lookups would answer a
 *  missing connection with their own error text, and the persona calls the CRM "real, connected". */
export function sharedRoomContactsLine(probes: Pick<ConnectionProbes, "env" | "fileExists"> = liveProbes): string {
  return crmConnected(probes.env, probes.fileExists)
    ? "Your contacts service (the CRM, Twenty) is connected; you can use the contact lookups you have here. If a lookup fails, say that the contact lookup did not work, and do not repeat a tool's error text."
    : "Your contacts service (the CRM, Twenty) is not connected. If you are asked to look someone up, say that contacts are not connected. Nothing is broken, and do not repeat a tool's error text.";
}

/** The block the model reads. Names both lists so "not listed" is never ambiguous. */
export function connectionsMarkdown(state: ConnectionState): string {
  const on = KEYS.filter((k) => state[k]).map((k) => LABELS[k]);
  const off = KEYS.filter((k) => !state[k]).map((k) => LABELS[k]);
  const lines = [
    "## What is connected right now",
    "Web chat and Telegram are how I talk; the services below are separate connections the owner makes.",
    `Connected: ${on.length ? on.join("; ") : "none of them yet"}.`,
    `Not connected: ${off.length ? off.join("; ") : "nothing, all are connected"}.`,
    "Only what is connected is something I can do today. When asked what I can do, I describe that, and I offer to help connect the rest (the owner does it in the console). A tool I carry for something that is not connected cannot work yet. I never call a missing connection a setup fault or an error on my side: it simply is not connected, and I say so plainly and offer to connect it.",
  ];
  return lines.join("\n");
}
