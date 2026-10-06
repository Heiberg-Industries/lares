// A test database lives in a throwaway Postgres container. When the test stops it, Postgres ends
// every open session with FATAL 57P01. A connection the pool has already released, whose socket is
// not yet closed, then hears that error with nobody listening, and vitest fails the whole run with
// an "unhandled error" although every test passed (LAR-83). Every pool a test builds against a
// container goes through `quiet`, which gives the pool and each of its connections a listener.
import { Pool, type PoolConfig } from "pg";

/** Attach the two listeners to a pool a test built, and hand the same pool back. */
export function quiet<T extends Pool>(pool: T): T {
  pool.on("error", () => undefined);
  pool.on("connect", (client) => client.on("error", () => undefined));
  return pool;
}

/** A pool over `connectionString` (or a full config) that survives its container stopping. */
export function quietPool(config: string | PoolConfig): Pool {
  return quiet(new Pool(typeof config === "string" ? { connectionString: config } : config));
}
