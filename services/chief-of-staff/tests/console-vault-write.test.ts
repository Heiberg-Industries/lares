// The Vault note write in a private Console conversation, from the definition the Console writes.
//
// An agent created in the Console gets the neutral chief-of-staff template, which grants
// `vault` at `write-with-confirm` over private, shared and facts. A Console conversation then
// narrows the tool list to the private surface. The note write used to be dropped there, so an
// agent whose only door is the Console could never save a note or raise a card for one.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const fake = vi.hoisted(() => ({ definition: {} as unknown }));
vi.mock("@lares/agent-kit/console-turn-authority", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/console-turn-authority")>()),
  requireConsoleSessionBinding: async () => ({}),
}));
vi.mock("../lib/definition.js", () => ({ thisAgent: async () => ({ loaded: { definition: fake.definition } }) }));
import { parseDefinition } from "@lares/agent-kit/definition";
import resolver from "../agent/tools/catalogue.js";
import { runDynamic } from "../../../packages/agent-kit/tests/helpers/eve-dynamic.js";

const NOTE_WRITE = "agent-kit__vault_write";
const OUT_OF_SCOPE = ["agent-kit__vault_file", "agent-kit__vault_drop", "remember", "forget", "save_note"];
const auth = { authenticator: "lares-console", principalType: "user", principalId: "member-a",
  attributes: { lares_member_id: "member-a", lares_admission_nonce: "a".repeat(43), lares_purpose: "human" } };
const consoleCtx = { session: { id: "console-note", turn: { id: "turn-1", sequence: 1 }, auth: { current: auth, initiator: auth } } };
const nativeCtx = { session: { id: "native-note", auth: { current: null, initiator: null } } };
const template = JSON.parse(readFileSync(new URL("../../../packages/agent-kit/templates/chief-of-staff/agent.json", import.meta.url), "utf8"));
const consoleCreated = (change: (d: any) => any = (d) => d) => parseDefinition(change({ ...template, name: "helper", display: "Helper" }));
// The catalogue is one eve 1.0 `defineDynamic` function. Each call here is a NEW conversation: a
// fresh memo store, so the tool list is decided again from the definition as it stands.
const resolve = async (ctx: unknown) => (await runDynamic(resolver, ctx as Record<string, unknown>)) as Record<string, { approval?: unknown }>;

beforeEach(() => {
  vi.stubEnv("LARES_AGENT_NAME", "helper");
  vi.stubEnv("LARES_AGENT_INCARNATION", "11111111-1111-4111-8111-111111111111");
  fake.definition = consoleCreated();
});
afterEach(() => vi.unstubAllEnvs());

describe("the Vault note write in a Console conversation", () => {
  it("is offered from a Console-created definition, behind its approval card", async () => {
    const tools = await resolve(consoleCtx);
    expect(tools).toHaveProperty(NOTE_WRITE);
    expect(tools[NOTE_WRITE]!.approval).toBeDefined();
    for (const name of OUT_OF_SCOPE) expect(tools, name).not.toHaveProperty(name);
  });

  it("is still offered on a native channel", async () => {
    expect(await resolve(nativeCtx)).toHaveProperty(NOTE_WRITE);
  });

  it("is not offered when the grant does not reach the private area at write-with-confirm", async () => {
    for (const vault of [
      { capability: "vault", scope: "read", areas: ["private", "shared", "facts"] },
      { capability: "vault", scope: "write-with-confirm", areas: ["shared", "facts"] },
    ]) {
      fake.definition = consoleCreated((d) => ({ ...d, grants: d.grants.map((g: any) => g.capability === "vault" ? vault : g) }));
      expect(await resolve(consoleCtx), JSON.stringify(vault)).not.toHaveProperty(NOTE_WRITE);
    }
    fake.definition = consoleCreated((d) => ({ ...d, autonomy: { ...d.autonomy, vault: "never" } }));
    expect(await resolve(consoleCtx)).not.toHaveProperty(NOTE_WRITE);
  });
});
