// The next page of a link read earlier in the same turn runs without an approval card, while a
// new link in a turn that has read somebody else's words still asks. The tool's own `approval`
// is called the way eve calls it: with the session, the turn and the tool input.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import { resetTaintForTests } from "@lares/agent-kit/origin-taint";
import readUrl from "../catalogue/read_url.js";

const session = { id: "s1", turn: { id: "t1" } };
const runCtx = { session } as never;
const approvalFor = (toolInput: unknown) =>
  (readUrl as unknown as { approval: (c: unknown) => Promise<unknown> }).approval({ session, toolInput });

let server: Server | undefined;
let tokenDir: string;

beforeEach(async () => {
  tokenDir = mkdtempSync(join(tmpdir(), "readability-token-"));
  writeFileSync(join(tokenDir, "readability-token"), "test-token\n");
  process.env["READABILITY_TOKEN_FILE"] = join(tokenDir, "readability-token");
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ title: "Long", text: "A".repeat(20_000) }));
  });
  const port = await new Promise<number>((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
  process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  resetTaintForTests();
  delete process.env["READABILITY_URL"];
  delete process.env["READABILITY_TOKEN_FILE"];
  rmSync(tokenDir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server!.close(() => resolve()));
});

describe("read_url approval for the next page", () => {
  const A = "https://example.com/a";

  it("asks for the first read after untrusted text, then lets page 2 of that link run without a card", async () => {
    // A clean turn reads the link; the read taints the turn.
    expect(await approvalFor({ url: A })).toBe("not-applicable");
    await readUrl.execute({ url: A }, runCtx);
    // The turn is now tainted: the same link from the start, or a new link, asks.
    expect(await approvalFor({ url: A })).toBe("user-approval");
    expect(await approvalFor({ url: "https://example.com/b" })).toBe("user-approval");
    expect(await approvalFor({ url: "https://example.com/b", offset: 12_000 })).toBe("user-approval");
    // Page 2 of the link already read: no card.
    expect(await approvalFor({ url: A, offset: 12_000 })).toBe("not-applicable");
  });

  it("does not exempt a link whose read failed", async () => {
    await readUrl.execute({ url: A }, runCtx);
    server!.removeAllListeners("request");
    server!.on("request", (_req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "refused" }));
    });
    await expect(readUrl.execute({ url: "https://example.com/c" }, runCtx)).rejects.toThrow();
    expect(await approvalFor({ url: "https://example.com/c", offset: 12_000 })).toBe("user-approval");
  });
});
