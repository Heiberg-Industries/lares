import { defineTool } from "eve/tools";
import { z } from "zod";

import { makeSignalsClient, SignalsUnavailableError, type SignalRow } from "../../src/signals-client.js";
import extension from "../extension.js";

export interface SignalsRecentDeps { recent(query: { since?: string; severity?: SignalRow["severity"]; project?: string; limit?: number }): Promise<SignalRow[]> }

function defaultRecent(query: Parameters<SignalsRecentDeps["recent"]>[0]) {
  const client = makeSignalsClient(() => extension.config.signals);
  return client.signalsRecent(query);
}

export function signalCard(row: SignalRow) {
  return {
    text: `${row.severity} · [${row.project}] ${row.title} · ${row.lastSeen}${row.linearRef ? ` · ${row.linearRef}` : ""}`,
    ...(row.count > 1 ? { count: row.count } : {}),
    ...(row.state === "recovered" ? { state: row.state } : {}),
  };
}

export function createSignalsRecentTool(deps: SignalsRecentDeps) {
  return defineTool({
    description:
      "Read recent operational signals from the signal spine. Call this before answering whether " +
      "anything is alerting, what broke, or what the spine saw about a project. A typed unavailable " +
      "result means the spine could not be read and is never an all-clear. An empty cards list is the " +
      "only evidence that the query found no signals.",
    inputSchema: z.object({
      since: z.string().datetime().optional().describe("Only signals at or after this ISO timestamp."),
      severity: z.enum(["error", "warn", "info"]).optional(),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async execute(query) {
      try {
        const rows = await deps.recent(query);
        return { cards: rows.map(signalCard) };
      } catch (error) {
        return {
          cards: [],
          unavailable: error instanceof SignalsUnavailableError
            ? error.message
            : `signal spine could not be read — ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}

export default createSignalsRecentTool({ recent: defaultRecent });
