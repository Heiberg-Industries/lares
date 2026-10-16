import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { errorDetail } from "../lib/error-detail.js";

/**
 * A schedule's failure report said only "TypeError: fetch failed" — `String(err)`
 * drops the `cause` that says WHY (refused, timed out, proxy said no). These pin that the
 * report text carries the cause chain, system codes and the parts of an AggregateError.
 */
describe("errorDetail", () => {
  it("keeps a plain error as String(err) would", () => {
    expect(errorDetail(new Error("boom"))).toBe("Error: boom");
  });

  it("passes a non-error through String()", () => {
    expect(errorDetail("just text")).toBe("just text");
    expect(errorDetail(undefined)).toBe("undefined");
  });

  it("names the cause of a failed fetch, with its system code", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:8888"), { code: "ECONNREFUSED" });
    const err = new TypeError("fetch failed", { cause });
    expect(errorDetail(err)).toBe(
      "TypeError: fetch failed\ncaused by: Error: connect ECONNREFUSED 10.0.0.5:8888",
    );
  });

  it("adds a code the message does not already show", () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(errorDetail(new TypeError("fetch failed", { cause }))).toBe(
      "TypeError: fetch failed\ncaused by: ConnectTimeoutError: Connect Timeout Error [UND_ERR_CONNECT_TIMEOUT]",
    );
  });

  it("lists every part of an AggregateError, whose own message is often empty", () => {
    const v4 = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const v6 = Object.assign(new Error("connect ECONNREFUSED ::1:1"), { code: "ECONNREFUSED" });
    const agg = Object.assign(new AggregateError([v4, v6]), { code: "ECONNREFUSED" });
    expect(errorDetail(agg)).toBe(
      "AggregateError [ECONNREFUSED]\n" +
      "part: Error: connect ECONNREFUSED 127.0.0.1:1\n" +
      "part: Error: connect ECONNREFUSED ::1:1",
    );
  });

  it("follows a chain of causes and stops on a loop", () => {
    const inner = new Error("socket hang up");
    const middle = new Error("tunnel failed", { cause: inner });
    const outer = new TypeError("fetch failed", { cause: middle });
    (inner as { cause?: unknown }).cause = outer;
    expect(errorDetail(outer)).toBe(
      "TypeError: fetch failed\ncaused by: Error: tunnel failed\ncaused by: Error: socket hang up",
    );
  });

  it("names a non-error cause", () => {
    expect(errorDetail(new Error("outer", { cause: "proxy said 403" }))).toBe(
      "Error: outer\ncaused by: proxy said 403",
    );
  });
});

describe("failure reports carry the cause", () => {
  it("no emitSignal call passes a caught error through String()", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    for (const dir of ["agent", "catalogue", "lib"]) {
      for (const rel of readdirSync(join(root, dir), { recursive: true }) as string[]) {
        if (!rel.endsWith(".ts")) continue;
        const src = readFileSync(join(root, dir, rel), "utf8");
        for (const call of src.matchAll(/emitSignal\(([^;]*?)\);/gs)) {
          if (/String\((e|err|error)\)/.test(call[1]!)) offenders.push(`${dir}/${rel}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
