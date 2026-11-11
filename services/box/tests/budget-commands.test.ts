import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main, renderNativePolicy, REVIEWED_INPUT_TOKENS } from "../bin/render-native-policy.js";
import { parseBudgetNativePolicyDocument, selectBudgetNativeReviewedPolicy } from "../../keeper/lib/budget-native-host.js";
import { NATIVE_CUSTODY_POLICY_BYTES } from "../../keeper/lib/budget-native-custody.js";
import { createHash } from "node:crypto";
import { gatewayAdmissionProfile } from "../lib/gateway-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const request = {
  alias: "lares-brain", providerModel: "anthropic/claude-opus-5", gatewayUrl: "http://lares-gateway:4000",
  installationLimit: "100", personLimit: "15",
  prices: { input: "5", output: "25", cacheRead: "0.5", cacheWrite: "6.25" },
};

describe("lares budget commands", () => {
  it("covers step order, interruption and refusal against a stub docker and keeper", () => {
    execFileSync("python3", ["-B", join(here, "budget-commands-safety.py")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }, 60_000);

  // An update that upgrades the agents' stores stops the agents and leaves a note of which ones
  // (update.sh). `lares agent refresh` is what starts them again, and only when the note says
  // every store was verified. Run on the same stub docker and keeper as the checks above.
  it("agent refresh starts the agents an update stopped, and nothing while the stores are half upgraded", () => {
    const script = String.raw`
import importlib.util, json, sys, unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location("budget_commands_safety", sys.argv[1])
safety = importlib.util.module_from_spec(spec)
spec.loader.exec_module(safety)
ok = safety.ok

class AgentsStoppedByAnUpdate(safety.BudgetCommandTests):
    def note_path(self) -> Path:
        return self.prefix / "var/lib/lares-maintenance/update/workflow-step.json"

    def write_note(self, phase: str, agents: list) -> None:
        self.note_path().parent.mkdir(parents=True, exist_ok=True)
        self.note_path().write_text(json.dumps({"version": 1, "release": "2026-10-01", "updateId": "41", "snapshotId": "9f8e7d6c",
                                                "phase": phase, "agents": agents}))

    def listed(self) -> None:
        self.keeper.answers["definition.list"] = ok([{"name": name, "status": "valid", "hash": letter * 64}
                                                     for name, letter in (("first", "a"), ("second", "b"), ("third", "c"))])
        self.keeper.answers["definition.refresh-image"] = ok({"moved": False, "state": "current", "reason": "already on this release"})

    def reconciled(self) -> list:
        return [(r["input"]["name"], r["input"]["hash"]) for r in self.keeper.requests if r["action"] == "definition.reconcile"]

    def test_starts_each_stopped_agent_once_and_removes_the_note(self) -> None:
        self.listed()
        self.write_note("migrated", ["first", "second"])
        # The keeper starts stopped agents by itself when it comes up: one is already running.
        running = {"first": False, "second": True}
        self.keeper.answers["definition.get"] = lambda request: ok({"runtime": {"running": running[request["input"]["name"]]}})
        self.keeper.answers["definition.reconcile"] = ok({"running": True, "healthy": True})
        code, output = self.run_command("agent-refresh")
        self.assertEqual(code, 0, output)
        self.assertEqual(self.reconciled(), [("first", "a" * 64)])
        self.assertIn("Starting first again on this release", output)
        self.assertIn("first is running again", output)
        self.assertNotIn("Starting second", output)
        self.assertFalse(self.note_path().exists())
        # The agents were started before the ordinary move onto the new software was asked for.
        actions = self.keeper.actions()
        self.assertLess(actions.index("definition.reconcile"), actions.index("definition.refresh-image"))
        self.assertEqual([r["input"]["name"] for r in self.keeper.requests if r["action"] == "definition.refresh-image"], ["first", "second", "third"])

    def test_an_agent_that_does_not_come_up_is_named_and_stays_on_the_note(self) -> None:
        self.listed()
        self.write_note("migrated", ["first", "second", "gone"])
        self.keeper.answers["definition.get"] = ok({"runtime": {"running": False}})
        self.keeper.answers["definition.reconcile"] = lambda request: (
            ok({"running": True, "healthy": True}) if request["input"]["name"] == "first" else ok({"running": False, "reason": "its settings were refused"}))
        code, output = self.run_command("agent-refresh")
        self.assertNotEqual(code, 0, output)
        self.assertIn("second did not start on this release: its settings were refused. Start it with: sudo lares agent start second", output)
        self.assertIn("gone was stopped by the update and the keeper does not list it as ready to run", output)
        self.assertEqual(json.loads(self.note_path().read_text())["agents"], ["second", "gone"])
        self.assertEqual(json.loads(self.note_path().read_text())["phase"], "migrated")

    def test_starts_nothing_while_the_stores_are_not_all_verified(self) -> None:
        for phase in ("stopping", "migrating"):
            self.listed()
            self.write_note(phase, ["first", "second"])
            self.keeper.requests.clear()
            code, output = self.run_command("agent-refresh")
            self.assertNotEqual(code, 0, output)
            self.assertIn("stopped before every agent store was upgraded and verified, so no agent was started", output)
            self.assertIn("Run the same update again", output)
            self.assertEqual(self.keeper.actions(), [])
            self.assertEqual(json.loads(self.note_path().read_text())["agents"], ["first", "second"])

    def test_a_note_it_cannot_read_starts_nothing(self) -> None:
        self.listed()
        self.note_path().parent.mkdir(parents=True, exist_ok=True)
        self.note_path().write_text("{not json")
        code, output = self.run_command("agent-refresh")
        self.assertNotEqual(code, 0, output)
        self.assertIn("cannot be read, so no agent was started", output)
        self.assertEqual(self.keeper.actions(), [])

    def test_without_a_note_it_behaves_as_before(self) -> None:
        self.listed()
        code, output = self.run_command("agent-refresh")
        self.assertEqual(code, 0, output)
        self.assertNotIn("definition.reconcile", self.keeper.actions())

names = [name for name in dir(AgentsStoppedByAnUpdate) if name.startswith("test_") and name not in dir(safety.BudgetCommandTests)]
suite = unittest.TestSuite(AgentsStoppedByAnUpdate(name) for name in sorted(names))
result = unittest.TextTestRunner(stream=sys.stderr, verbosity=1).run(suite)
if len(names) != 5 or result.testsRun != 5 or not result.wasSuccessful():
    sys.exit(1)
`;
    const result = spawnSync("python3", ["-B", "-c", script, join(here, "budget-commands-safety.py")], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }, 60_000);

  it("the lares command hands budget and agent commands the release's pinned image", () => {
    const root = mkdtempSync(join(tmpdir(), "lares-wrapper-"));
    try {
      const release = join(root, "opt", "lares", "releases", "r1"), ops = join(release, "services", "box", "ops"), bin = join(root, "bin");
      mkdirSync(ops, { recursive: true });
      mkdirSync(bin);
      symlinkSync(release, join(root, "opt", "lares", "current"));
      for (const name of ["lares", "engine-run.sh"]) copyFileSync(join(here, "..", "ops", name), join(ops, name));
      const image = `example.invalid/keeper@sha256:${"a".repeat(64)}`;
      writeFileSync(join(release, "release.json"), JSON.stringify({ images: { "lares-keeper": image } }));
      writeFileSync(join(ops, "budget-commands.py"), "import sys\nprint(' '.join(sys.argv[1:]))\n");
      writeFileSync(join(bin, "id"), "#!/bin/sh\necho 0\n");
      chmodSync(join(bin, "id"), 0o755);
      const lares = (...args: string[]) => spawnSync("bash", [join(ops, "lares"), ...args], {
        encoding: "utf8", env: { ...process.env, LARES_PREFIX: root, PATH: `${bin}:${process.env.PATH}` },
      });
      const setup = lares("budget", "setup", "--yes");
      expect(setup.status).toBe(0);
      expect(setup.stdout).toContain(`--image ${image}`);
      expect(setup.stdout.trim().endsWith("setup --yes")).toBe(true);
      const start = lares("agent", "start", "my-agent", "--member", "person@example.test");
      expect(start.status).toBe(0);
      expect(start.stdout.trim().endsWith("agent-start my-agent --member person@example.test")).toBe(true);
      const refresh = lares("agent", "refresh");
      expect(refresh.status).toBe(0);
      expect(refresh.stdout.trim().endsWith("agent-refresh")).toBe(true);
      const bringAcross = lares("agent", "import", "/srv/old-agents", "--yes");
      expect(bringAcross.status).toBe(0);
      expect(bringAcross.stdout.trim().endsWith("agent-import /srv/old-agents --yes")).toBe(true);
      const keySet = lares("agent", "provider-key", "set", "my-agent", "--key-file", "/root/key");
      expect(keySet.status).toBe(0);
      expect(keySet.stdout.trim().endsWith("agent-provider-key set my-agent --key-file /root/key")).toBe(true);
      const keyRemove = lares("agent", "provider-key", "remove", "my-agent");
      expect(keyRemove.status).toBe(0);
      expect(keyRemove.stdout.trim().endsWith("agent-provider-key remove my-agent")).toBe(true);
      expect(lares("agent", "provider-key", "set").status).toBe(64);
      expect(lares("agent", "provider-key").status).toBe(64);
      expect(lares("agent", "import").status).toBe(64);
      expect(lares("agent", "refresh", "my-agent").status).toBe(64);
      expect(lares("budget").status).toBe(64);
      expect(lares("agent", "stop", "my-agent").status).toBe(64);
      expect(lares("agent", "start").status).toBe(64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the reviewed budget policy", () => {
  it("builds a policy the keeper accepts, with the agreed hold at the suggested prices", () => {
    const result = renderNativePolicy(request);
    expect(result.maximumLiability).toBe("1.0346");
    expect(REVIEWED_INPUT_TOKENS).toBe(100_000);
    expect(parseBudgetNativePolicyDocument(JSON.stringify(result.policy))).toEqual(result.policy);
    const [policy] = result.policy.policies;
    expect(policy!.key.models).toEqual(["lares-brain"]);
    expect(policy!.key.blocked).toBe(true);
    expect(policy!.team.maxBudget).toBe("100");
    expect(policy!.user.maxBudget).toBe("15");
    expect(policy!.membership.maxBudget).toBe("15");
    expect(policy!.key.maxBudget).toBe("15");
    expect(result.policy.endpointHash).toBe(createHash("sha256")
      .update("lares.native-endpoint.v1\0http://lares-gateway:4000\0https://api.anthropic.com").digest("hex"));
  });

  it("writes amounts the way the ledger stores them", () => {
    const result = renderNativePolicy({ ...request, installationLimit: "100.50", personLimit: "12.50" });
    expect(result.installationLimit).toBe("100.5");
    expect(result.personLimit).toBe("12.5");
  });

  it("refuses a limit below what one call can hold", () => {
    expect(() => renderNativePolicy({ ...request, personLimit: "1" })).toThrow(/One model call can cost up to \$1\.0346/);
    expect(() => renderNativePolicy({ ...request, personLimit: "1.0346" })).not.toThrow();
  });

  it("refuses a person limit above the installation limit, and unusable amounts", () => {
    expect(() => renderNativePolicy({ ...request, personLimit: "101" })).toThrow(/above the installation limit/);
    for (const bad of ["0", "-1", "ten", "", "1e3"]) {
      expect(() => renderNativePolicy({ ...request, personLimit: bad }), bad).toThrow(/per-person limit/);
    }
    expect(() => renderNativePolicy({ ...request, prices: { ...request.prices, input: "cheap" } })).toThrow(/input price/);
    expect(() => renderNativePolicy({ ...request, providerModel: "local/some-model" })).toThrow(/OpenAI or Anthropic/);
  });


  // Captured from the renderer before the other aliases were priced: the brain's policy must stay byte for byte what it was.
  const BRAIN_POLICY_BYTES = '{"capability":{"version":1,"provider":"anthropic","model":"claude-opus-5","providerBaseUrl":"https://api.anthropic.com","aliases":["lares-brain","lares-writer","lares-utility","lares-gate"],"maxBodyBytes":1048576,"maxOutputTokens":16384},"pricing":{"version":1,"capabilityHash":"584dce29dbec5a7a5809f13d3aa0ba6bf76fd09c1463146dd2dca6e560c2ffda","format":"anthropic","limits":{"inputTokens":100000,"outputTokens":16384},"usdPerMillionTokens":{"input":"5","output":"25","cacheRead":"0.5","cacheWrite":"6.25"}},"maximumLiability":"1.0346","team":{"maxBudget":"100","models":["lares-brain","lares-writer","lares-utility","lares-gate"],"budgetDuration":"1d"},"user":{"maxBudget":"15","userRole":"internal_user","autoCreateKey":false},"membership":{"maxBudget":"15","allowedModels":["lares-brain","lares-writer","lares-utility","lares-gate"],"budgetDuration":"1d","role":"user"},"key":{"maxBudget":"15","models":["lares-brain"],"budgetDuration":"1d","keyType":"llm_api","blocked":true}}';
  const sonnet = { input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" };
  const haiku = { input: "1", output: "5", cacheRead: "0.1", cacheWrite: "1.25" };
  const embedding = { model: "mistral-embed", baseUrl: "https://api.mistral.ai/v1" };

  it("keeps the brain's policy first and byte for byte what it was, and prices the other served aliases with the brain's rates", () => {
    const plain = renderNativePolicy(request);
    expect(JSON.stringify(plain.policy.policies[0])).toBe(BRAIN_POLICY_BYTES);
    expect(plain.policy.policies.map(policy => policy.key.models[0])).toEqual(["lares-brain", "lares-writer", "lares-utility", "lares-gate"]);
    for (const policy of plain.policy.policies) {
      expect(policy.pricing).toEqual(plain.policy.policies[0]!.pricing);
      expect(policy.team).toEqual(plain.policy.policies[0]!.team);
      expect(policy.user).toEqual(plain.policy.policies[0]!.user);
      expect(policy.membership).toEqual(plain.policy.policies[0]!.membership);
      expect(policy.key.blocked).toBe(true);
    }
    expect(plain.pricedAliases.map(entry => [entry.alias, entry.model])).toEqual([
      ["lares-brain", "anthropic/claude-opus-5"], ["lares-writer", "anthropic/claude-opus-5"],
      ["lares-utility", "anthropic/claude-opus-5"], ["lares-gate", "anthropic/claude-opus-5"],
    ]);
  });

  it("reviews the exact profile the gateway runs and prices a purpose that has a model of its own from that model's rates", () => {
    const plain = renderNativePolicy(request);
    const purposeModels = { writer: "anthropic/claude-sonnet-4-5", gate: "anthropic/claude-haiku-4-5" };
    const result = renderNativePolicy({ ...request, purposeModels, aliasPrices: { "lares-writer": sonnet, "lares-gate": haiku } });
    const [brain, writer, utility, gate] = result.policy.policies;
    expect(brain!.capability).toEqual(gatewayAdmissionProfile({ alias: request.alias, providerModel: request.providerModel, purposeModels }));
    expect(brain!.pricing.usdPerMillionTokens).toEqual(request.prices);
    expect(writer!.pricing.usdPerMillionTokens).toEqual(sonnet);
    expect(utility!.pricing.usdPerMillionTokens).toEqual(request.prices);
    expect(gate!.pricing.usdPerMillionTokens).toEqual(haiku);
    expect(gate!.key.models).toEqual(["lares-gate"]);
    expect(writer!.maximumLiability).toBe("0.62076");
    expect(brain!.pricing.capabilityHash).not.toBe(plain.policy.policies[0]!.pricing.capabilityHash);
    expect(result.pricedAliases.map(entry => [entry.alias, entry.model])).toEqual([
      ["lares-brain", "anthropic/claude-opus-5"], ["lares-writer", "anthropic/claude-sonnet-4-5"],
      ["lares-utility", "anthropic/claude-opus-5"], ["lares-gate", "anthropic/claude-haiku-4-5"],
    ]);
    expect(parseBudgetNativePolicyDocument(JSON.stringify(result.policy))).toEqual(result.policy);
    expect(result.model).toBe("anthropic/claude-opus-5");
    // A purpose model equal to the brain model is the default, so nothing changes and no prices are needed.
    const same = renderNativePolicy({ ...request, purposeModels: { writer: request.providerModel } });
    expect(same.policy).toEqual(plain.policy);
    expect(() => renderNativePolicy({ ...request, purposeModels })).toThrow(/lares-writer.*needs its prices/);
    expect(() => renderNativePolicy({ ...request, purposeModels: { writer: "anthropic/claude-sonnet-4-5" }, aliasPrices: { "lares-writer": { ...sonnet, input: "cheap" } } })).toThrow(/input price/);
    expect(() => renderNativePolicy({ ...request, aliasPrices: { "lares-embed": { input: "0.1" } } })).toThrow(/does not serve/);
    expect(() => renderNativePolicy({ ...request, aliasPrices: { "lares-brain": sonnet } })).toThrow(/does not serve/);
    expect(() => renderNativePolicy({ ...request, purposeModels: { writer: "openai/gpt-4o-mini" } })).toThrow(/same provider/);
    expect(() => renderNativePolicy({ ...request, purposeModels: { brain: "anthropic/x" } as never })).toThrow(/Only the writer, utility and gate/);
  });

  it("prices the embedding alias on input tokens alone, held at the most one call may carry", () => {
    const plain = renderNativePolicy(request);
    const result = renderNativePolicy({ ...request, embedding, aliasPrices: { "lares-embed": { input: "0.1" } } });
    expect(result.policy.policies).toHaveLength(5);
    const embed = result.policy.policies[4]!;
    expect(embed.capability).toEqual(gatewayAdmissionProfile({ alias: request.alias, providerModel: request.providerModel, embedding }));
    expect(embed.pricing.format).toBe("embedding");
    expect(embed.pricing.limits).toEqual({ inputTokens: 32 * 8192, outputTokens: 1 });
    expect(embed.pricing.usdPerMillionTokens).toEqual({ input: "0.1", output: "0", cacheRead: "0", cacheWrite: "0" });
    expect(embed.maximumLiability).toBe("0.0262144");
    expect(embed.key.models).toEqual(["lares-embed"]);
    expect(result.policy.policies[0]!.pricing.format).toBe("anthropic");
    expect(result.maximumLiability).toBe(plain.maximumLiability);
    expect(result.pricedAliases[4]).toEqual({ alias: "lares-embed", model: "mistral-embed", prices: { input: "0.1", output: "0", cacheRead: "0", cacheWrite: "0" } });
    const small = renderNativePolicy({ ...request, embedding: { ...embedding, maxInputTokens: "2048" }, aliasPrices: { "lares-embed": { input: "0.1" } } });
    expect(small.policy.policies[4]!.pricing.limits.inputTokens).toBe(32 * 2048);
    expect(parseBudgetNativePolicyDocument(JSON.stringify(result.policy))).toEqual(result.policy);
    expect(() => renderNativePolicy({ ...request, embedding })).toThrow(/needs an input price/);
    expect(() => renderNativePolicy({ ...request, embedding, aliasPrices: { "lares-embed": { input: "0" } } })).toThrow(/must not all be zero/);
    expect(() => renderNativePolicy({ ...request, embedding: { ...embedding, baseUrl: "http://api.mistral.ai/v1" }, aliasPrices: { "lares-embed": { input: "0.1" } } })).toThrow(/HTTPS/);
    expect(() => renderNativePolicy({ ...request, embedding: { ...embedding, maxInputTokens: "many" }, aliasPrices: { "lares-embed": { input: "0.1" } } })).toThrow(/MAX_INPUT_TOKENS/);
  });

  it("checks the per-person limit against every alias, and keeps five policies under the custody size limit", () => {
    const purposeModels = { writer: "anthropic/claude-sonnet-4-5", utility: "anthropic/claude-haiku-4-5", gate: "anthropic/claude-haiku-4-5" };
    const aliasPrices = { "lares-writer": sonnet, "lares-utility": haiku, "lares-gate": haiku, "lares-embed": { input: "0.1" } };
    const five = renderNativePolicy({ ...request, purposeModels, embedding, aliasPrices });
    expect(five.policy.policies).toHaveLength(5);
    expect(Buffer.byteLength(JSON.stringify(five.policy), "utf8")).toBeLessThan(NATIVE_CUSTODY_POLICY_BYTES);
    // A pricier writer than the brain: the limit that suits the brain is too low for it.
    expect(() => renderNativePolicy({ ...request, personLimit: "1.0346", purposeModels: { writer: "anthropic/claude-opus-5-5" }, aliasPrices: { "lares-writer": { input: "50", output: "250", cacheRead: "5", cacheWrite: "62.5" } } }))
      .toThrow(/call to lares-writer can cost up to/);
  });

  it("selects each served alias from the document by its key, as the keeper does", () => {
    const five = renderNativePolicy({ ...request, purposeModels: { writer: "anthropic/claude-sonnet-4-5" }, embedding, aliasPrices: { "lares-writer": sonnet, "lares-embed": { input: "0.1" } } });
    const document = parseBudgetNativePolicyDocument(JSON.stringify(five.policy));
    for (const [index, alias] of ["lares-brain", "lares-writer", "lares-utility", "lares-gate", "lares-embed"].entries())
      expect(selectBudgetNativeReviewedPolicy(document, alias)).toEqual(five.policy.policies[index]);
    expect(() => selectBudgetNativeReviewedPolicy(document, "lares-other")).toThrow();
  });


  it("refuses a request with a repeated field", () => {
    expect(() => main('{"alias":"a","alias":"b"}', () => {})).toThrow();
  });
});
