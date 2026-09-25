import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { main, parseArgs } from "../bin/doctor.js";

describe("the install-time model-only check", () => {
  it("requires an explicit model test", () => {
    expect(() => parseArgs(["--model-only"])).toThrow(/requires --test-model/);
  });

  it("checks the completion without querying the not-yet-migrated database", async () => {
    const out: string[] = [];
    const db = { query: vi.fn(), end: vi.fn() } as unknown as Pool;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }));
    const code = await main(
      ["--test-model", "--model-only", "--gateway", "http://127.0.0.1:4000", "--alias", "lares-brain", "--key-file", "/fixture/key"],
      { db, out: (line) => out.push(line), readKeyFile: () => "fixture-master-key", fetch: fetch as typeof globalThis.fetch },
    );
    expect(code).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("real completion");
    expect(out.join("\n")).not.toContain("fixture-master-key");
  });
});
