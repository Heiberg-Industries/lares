import { Pool } from "pg";
import { readFileSync } from "node:fs";

const password =
  process.env.PGPASSWORD ??
  (process.env.PGPASSWORD_FILE
    ? readFileSync(process.env.PGPASSWORD_FILE, "utf8").trim()
    : undefined);

export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? "5432"),
  database: process.env.PGDATABASE ?? "lares_state",
  user: process.env.PGUSER ?? "lares",
  password,
});
