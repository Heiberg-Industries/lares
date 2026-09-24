// pg-boss bootstrap — the Postgres-native job queue (no Redis, no separate broker).
// pg-boss owns scheduling + durability in its own `pgboss` schema, created on first start.
// Stage 3's runtime uses this to run trigger_schedules and deliver due reminders.
import PgBoss from "pg-boss";

export async function startBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  await boss.start(); // creates the pgboss.* schema on first run
  return boss;
}
