import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "eve/client";
import { toolResultFrom } from "eve/tools";
import { searchTool } from "@lares/agent-kit/note-tools";

// ORB-143 Task 2: vault_search is now mounted from the @lares/agent-kit eve extension under
// the mandatory `agent-kit__` prefix, not a local `agent/tools/vault_search.ts` file. Its
// schema is unchanged (searchTool("brain")'s execute() touches no extension config — see
// tests/tools-readonly.test.ts's header), so reconstructing it here for `toolResultFrom`'s
// schema validation is faithful to the real mounted tool.
const vaultSearchTool = searchTool("brain");

/**
 * Phase-1 success criterion: "agnosticism remains a direction, not a capability" until
 * a NON-Claude model drives a real agentic tool-calling loop — not just a text
 * completion — through the LiteLLM gateway. This boots the real `eve dev` server with
 * `EVE_SAGA_MODEL=mistral-small` (the standing-policy utility model — the exact
 * `model_name` from services/gateway/config.yaml:18, never hardcoded from memory),
 * points it at a fixture vault, sends one prompt over the real `eve/client` session
 * protocol, and asserts the transcript contains an actual `vault_search` tool call
 * plus a final answer that used its result.
 *
 * **Read this before debugging a failure here (2026-08-13).** The gateway key this agent
 * holds is SCOPED, and `mistral-small` is not in its list: the gateway answers
 * `401 key not allowed to access model. This key can only access
 * models=['claude-opus-4-8','claude-sonnet-4-6','claude-haiku-4-5','gpt-4o','gpt-5.5']`,
 * even though LiteLLM has Mistral configured with an API key present. So this suite fails
 * on ACCESS, not on eve, and the failure looks like a framework problem when it is a key
 * problem. Widening the key's model list is a one-line LiteLLM change.
 *
 * **This key-scoping paragraph is history (ORB-225, 2026-09-04).** The service's standing
 * utility alias is now `heiberg-utility` (see `lib/llm-complete.ts`'s `resolveModelForPurpose`)
 * and every model call — this test's Mistral target included — takes the gateway's router
 * route, where aliases resolve. Keys still gate access, just on the alias name now, not the raw
 * model id — so the key this test runs against must carry `heiberg-utility` (or whichever alias
 * this test targets), or it 401s exactly as the old per-model scoping did. Left in place as the
 * record of what the failure looked like.
 *
 * The criterion itself is already satisfied by other means: on 2026-08-13 the deployed
 * shadow was pointed at `gpt-4o` and chained `vault_search` → `vault_read` → an answer
 * using both, confirmed in Langfuse (`chat gpt-4o`). See the scorecard, criterion 4. Keep
 * this test targeting Mistral anyway — it is the standing utility-model policy, and the day
 * the key allows it, this is the check that proves it.
 *
 * Env-gated: needs a real, readable gateway key (GATEWAY_KEY_FILE, default
 * /run/secrets/gateway-key — same contract as lib/gateway-provider.ts) and a gateway
 * that can actually reach Mistral. Neither exists in a plain sandbox checkout (same
 * gap Tasks 1-2 hit for their own live smoke tests), so this suite SKIPS cleanly
 * instead of failing when the key file is absent — CI without gateway credentials
 * gets a skip, not a false red.
 */
const GATEWAY_KEY_FILE = process.env["GATEWAY_KEY_FILE"] ?? "/run/secrets/gateway-key";
const HAS_GATEWAY_KEY = existsSync(GATEWAY_KEY_FILE);
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a free port"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

describe.skipIf(!HAS_GATEWAY_KEY)("second-model tool-loop proof (mistral-small, live gateway)", () => {
  let vaultDir: string;
  let port: number;
  let serverProcess: ChildProcessWithoutNullStreams;
  let serverOutput = "";

  beforeAll(async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "eve-saga-proof-vault-"));
    // The distinctive filename IS the fact the proof correlates on: vault_search
    // returns paths, not file content, so "the final answer used the tool's result"
    // can only mean the model's reply reflects a path this specific call returned —
    // a name unlikely to appear in a model's answer by chance if it never called the
    // tool (or called it and ignored the result).
    writeFileSync(
      join(vaultDir, "foxtrot-seven-manifest.md"),
      "# Foxtrot Seven Manifest\n\nFoxtrot Seven is the crew callsign for the Lares agent roster: " +
        "Saga, Nora, Calliope, Tyche, and Marcel.\n",
    );
    writeFileSync(join(vaultDir, "unrelated.md"), "# Unrelated note\n\nNothing to do with the roster.\n");

    port = await getFreePort();

    serverProcess = spawn(
      "pnpm",
      ["exec", "eve", "dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: APP_ROOT,
        env: {
          ...process.env,
          EVE_SAGA_MODEL: "mistral-small",
          VAULT_PATH: vaultDir,
          GATEWAY_KEY_FILE,
        },
      },
    );
    serverProcess.stdout.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
    serverProcess.stderr.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));

    const client = new Client({ host: `http://127.0.0.1:${port}` });
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    for (;;) {
      try {
        await client.health();
        return;
      } catch (err) {
        lastError = err;
        if (Date.now() > deadline) {
          throw new Error(
            `eve dev server never became healthy: ${String(lastError)}\n--- server output ---\n${serverOutput}`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, 45_000);

  afterAll(() => {
    serverProcess?.kill();
    if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
  });

  it(
    "drives a real vault_search tool call through mistral-small and answers from its result",
    async () => {
      const client = new Client({ host: `http://127.0.0.1:${port}` });
      const { response } = await client.sessions.create({
        message:
          "Search the vault for the Lares agent roster and tell me the exact name of the " +
          "markdown file where you found it.",
      });
      const result = await response.result();

      // This is scorecard data, not something to tune into passing: if the model never
      // calls vault_search, this fails with the full event transcript attached so the
      // outcome is legible rather than papered over.
      const toolCalled = result.events.some(
        (event) =>
          event.type === "actions.requested" &&
          event.data.actions.some((action) => action.kind === "tool-call" && action.toolName === "agent-kit__vault_search"),
      );
      expect(
        toolCalled,
        `agent-kit__vault_search was never called by mistral-small. Full event transcript:\n${JSON.stringify(result.events, null, 2)}`,
      ).toBe(true);

      expect(result.status).toBe("completed");
      expect(result.message).toBeTruthy();

      // "A final answer using its result" — not just any non-empty reply. vault_search
      // only ever returns file paths (never file content), so the one thing a genuine
      // answer-from-the-result can reflect is a path the tool actually returned. Pull
      // the real action.result for this call and require the final message to
      // reference one of its hits, rather than asserting a hardcoded guess of what the
      // model said.
      const toolResultEvent = result.events.find(
        (event) => event.type === "action.result" && event.data.result.kind === "tool-result",
      );
      expect(
        toolResultEvent,
        `no action.result for agent-kit__vault_search was observed. Full event transcript:\n${JSON.stringify(result.events, null, 2)}`,
      ).toBeDefined();
      const matched =
        toolResultEvent?.type === "action.result" ? toolResultFrom(toolResultEvent.data.result, vaultSearchTool) : undefined;
      expect(matched, "action.result did not match the vault_search tool definition").toBeDefined();
      expect(matched?.output.hits.length ?? 0, "agent-kit__vault_search returned zero hits for the fixture vault").toBeGreaterThan(0);

      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const expectedFragment = normalize(matched!.output.hits[0]!.replace(/\.md$/, ""));
      const actualReply = normalize(result.message ?? "");
      expect(
        actualReply.includes(expectedFragment),
        `final message did not reference the tool's actual hit ("${matched!.output.hits[0]}"). ` +
          `Reply was: ${result.message}`,
      ).toBe(true);
    },
    60_000,
  );
});
