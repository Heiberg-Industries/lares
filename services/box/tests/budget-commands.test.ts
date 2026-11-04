import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main, renderNativePolicy, REVIEWED_INPUT_TOKENS } from "../bin/render-native-policy.js";
import { parseBudgetNativePolicyDocument } from "../../keeper/lib/budget-native-host.js";
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

  it("reviews the exact profile the gateway runs when a purpose has a model of its own, and says which aliases are not priced", () => {
    const plain = renderNativePolicy(request);
    expect(plain.unpricedAliases).toEqual([]);
    const result = renderNativePolicy({ ...request, purposeModels: { writer: "anthropic/claude-sonnet-4-5", gate: "anthropic/claude-haiku-4-5" } });
    expect(result.unpricedAliases).toEqual(["lares-writer", "lares-gate"]);
    const [policy] = result.policy.policies;
    expect(policy!.capability).toEqual(gatewayAdmissionProfile({
      alias: request.alias, providerModel: request.providerModel,
      purposeModels: { writer: "anthropic/claude-sonnet-4-5", gate: "anthropic/claude-haiku-4-5" },
    }));
    expect(policy!.pricing.capabilityHash).not.toBe(plain.policy.policies[0]!.pricing.capabilityHash);
    expect(parseBudgetNativePolicyDocument(JSON.stringify(result.policy))).toEqual(result.policy);
    expect(result.model).toBe("anthropic/claude-opus-5");
    // A purpose model equal to the brain model is the default, so nothing changes and nothing is unpriced.
    const same = renderNativePolicy({ ...request, purposeModels: { writer: request.providerModel } });
    expect(same.unpricedAliases).toEqual([]);
    expect(same.policy).toEqual(plain.policy);
    expect(() => renderNativePolicy({ ...request, purposeModels: { writer: "openai/gpt-4o-mini" } })).toThrow(/same provider/);
    expect(() => renderNativePolicy({ ...request, purposeModels: { brain: "anthropic/x" } as never })).toThrow(/Only the writer, utility and gate/);
  });

  it("refuses a request with a repeated field", () => {
    expect(() => main('{"alias":"a","alias":"b"}', () => {})).toThrow();
  });
});
