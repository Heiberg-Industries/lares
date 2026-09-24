import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { makeSignalsClient, SignalsUnavailableError } from "../src/signals-client.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tokenFile(value = "read-token\n") {
  const dir = mkdtempSync(join(tmpdir(), "signals-client-")); dirs.push(dir);
  const file = join(dir, "token"); writeFileSync(file, value); return file;
}

const row = {
  fingerprint: "budget:orakel", occurrence: 1, kind: "alert", severity: "warn", state: "open",
  title: "Orakel budget high", project: "orakel", source: "litellm", type: "budget",
  description: null, url: null, firstSeen: "2026-09-16T06:00:00Z", lastSeen: "2026-09-16T07:00:00Z",
  count: 2, linearRef: "ORB-999",
} as const;

describe("makeSignalsClient", () => {
  it("calls GET /signals with bearer auth and filters", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const client = makeSignalsClient(() => ({ tokenFile: tokenFile(), baseUrl: "https://spine/", fetch: async (url, init) => {
      request = { url: String(url), init }; return Response.json({ signals: [row] });
    }}));
    expect(await client.signalsRecent({ since: "2026-09-16T00:00:00Z", severity: "warn", project: "orakel", limit: 3 })).toEqual([row]);
    expect(request?.url).toBe("https://spine/signals?since=2026-09-16T00%3A00%3A00Z&severity=warn&project=orakel&limit=3");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer read-token");
  });

  it("returns a genuine empty list when the spine answers empty", async () => {
    const client = makeSignalsClient(() => ({ tokenFile: tokenFile(), baseUrl: "https://spine", fetch: async () => Response.json({ signals: [] }) }));
    await expect(client.signalsRecent()).resolves.toEqual([]);
  });

  it("throws typed unavailable when the token is removed", async () => {
    const client = makeSignalsClient(() => ({ tokenFile: "/does/not/exist", baseUrl: "https://spine", fetch }));
    await expect(client.signalsRecent()).rejects.toBeInstanceOf(SignalsUnavailableError);
  });

  it("rejects malformed rows instead of silently dropping them", async () => {
    const client = makeSignalsClient(() => ({ tokenFile: tokenFile(), baseUrl: "https://spine", fetch: async () => Response.json({ signals: [{ title: "half a row" }] }) }));
    await expect(client.signalsRecent()).rejects.toThrow(/invalid signal row/);
  });
});
