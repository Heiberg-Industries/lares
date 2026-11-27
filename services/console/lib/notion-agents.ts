// The agents that may be given the Notion key, read on the server. Kept apart from
// lib/notion-connection.ts, which the browser imports and must not pull in the database client.
import type { PoolClient } from "pg";
import { pool } from "./db";
import type { NotionAgent } from "./notion-connection";

/** Every chief-of-staff agent that is not retired, from its saved definition (the keeper gives the
 *  key to that role only). */
export async function notionAgents(db: Pick<PoolClient, "query"> = pool): Promise<NotionAgent[]> {
  const { rows } = await db.query<{ name: string; definition: { display?: unknown } | null }>(
    `SELECT name, definition FROM agent_definitions
      WHERE definition->>'role' = 'chief-of-staff' AND status <> 'retired' ORDER BY name`,
  );
  return rows.map((r) => ({
    name: r.name,
    displayName: typeof r.definition?.display === "string" && r.definition.display ? r.definition.display : r.name,
  }));
}
