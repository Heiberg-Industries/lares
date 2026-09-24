import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  AGENT_GATEWAY_BUDGET_DURATION,
  AGENT_GATEWAY_BUDGET_USD,
  LiteLLMGatewayKeys,
  gatewayModels,
} from "../lib/gateway-keys.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lares-gateway-key-"));
  roots.push(root);
  const masterKeyFile = join(root, "master");
  const secretFile = join(root, "agent-key");
  writeFileSync(masterKeyFile, "sk-test-master-key-only\n");
  return {
    root,
    masterKeyFile,
    secretFile,
    options: { gatewayUrl: "http://gateway:4000/", masterKeyFile, secretFile, name: "nora", aliasPrefix: "lares" },
  };
}

function policy(name = "nora") {
  return {
    key_alias: `lares-agent-${name}`,
    key_type: "llm_api",
    models: gatewayModels("lares"),
    max_budget: AGENT_GATEWAY_BUDGET_USD,
    budget_duration: AGENT_GATEWAY_BUDGET_DURATION,
  };
}

it("persists one local key before registering its exact allow-list and daily budget", async () => {
  const f = fixture();
  let stored: unknown;
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v2/key/info"))
      return Response.json({ info: stored ? [stored] : [] });
    const body = JSON.parse(String(init?.body));
    const local = readFileSync(f.secretFile, "utf8");
    expect(body.key).toBe(local);
    expect(body).toMatchObject({
      ...policy(),
      metadata: { managed_by: "lares", agent: "nora" },
    });
    stored = body;
    return Response.json(body);
  });

  const provisioner = new LiteLLMGatewayKeys(request as typeof fetch);
  await provisioner.ensure(f.options);
  const key = readFileSync(f.secretFile, "utf8");
  expect(key).toMatch(/^sk-[A-Za-z0-9_-]{43}$/);
  expect(statSync(f.secretFile).mode & 0o777).toBe(0o600);
  expect(request.mock.calls.map(([url]) => String(url))).toEqual([
    "http://gateway:4000/v2/key/info",
    "http://gateway:4000/key/generate",
    "http://gateway:4000/v2/key/info",
  ]);
  const firstLookup = JSON.parse(String(request.mock.calls[0]![1]?.body));
  expect(firstLookup).toEqual({ keys: [createHash("sha256").update(key).digest("hex")] });
  expect(JSON.stringify(firstLookup)).not.toContain(key);

  request.mockClear();
  await provisioner.ensure(f.options);
  expect(readFileSync(f.secretFile, "utf8")).toBe(key);
  expect(request).toHaveBeenCalledTimes(1);
  expect(String(request.mock.calls[0]![0])).toBe("http://gateway:4000/v2/key/info");
});

it("recovers a committed key after the generation response is lost", async () => {
  const f = fixture();
  let stored: unknown;
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/v2/key/info"))
      return Response.json({ info: stored ? [stored] : [] });
    stored = JSON.parse(String(init?.body));
    throw new Error("connection ended after commit");
  });
  await expect(new LiteLLMGatewayKeys(request as typeof fetch).ensure(f.options)).resolves.toBeUndefined();
  expect(readFileSync(f.secretFile, "utf8")).toMatch(/^sk-/);
});

it("deletes by hash and treats a lost delete response as success only after verification", async () => {
  const f = fixture();
  const key = "sk-existing-agent-key-only";
  const hash = createHash("sha256").update(key).digest("hex");
  writeFileSync(f.secretFile, key);
  let present = true;
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/v2/key/info"))
      return Response.json({ info: present ? [policy()] : [] });
    expect(String(input)).toBe("http://gateway:4000/key/delete");
    expect(JSON.parse(String(init?.body))).toEqual({ keys: [hash] });
    expect(String(init?.body)).not.toContain(key);
    present = false;
    throw new Error("connection ended after commit");
  });
  await expect(new LiteLLMGatewayKeys(request as typeof fetch).remove(f.options)).resolves.toBeUndefined();
  expect(readFileSync(f.secretFile, "utf8")).toBe(key);
  expect(request).toHaveBeenCalledTimes(3);
});

it("fails closed on a changed remote policy without minting another key", async () => {
  const f = fixture();
  writeFileSync(f.secretFile, "sk-existing-agent-key-only");
  const request = vi.fn(async () => Response.json({ info: [{ ...policy(), max_budget: 50 }] }));
  await expect(new LiteLLMGatewayKeys(request as typeof fetch).ensure(f.options))
    .rejects.toThrow("policy does not match");
  expect(request).toHaveBeenCalledTimes(1);
  expect(readFileSync(f.secretFile, "utf8")).toBe("sk-existing-agent-key-only");
});

it("refuses a linked or malformed managed secret and never sends it", async () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  writeFileSync(outside, "sk-outside-agent-key-only");
  symlinkSync(outside, f.secretFile);
  const request = vi.fn();
  await expect(new LiteLLMGatewayKeys(request as typeof fetch).ensure(f.options))
    .rejects.toThrow("not a regular file");
  expect(lstatSync(f.secretFile).isSymbolicLink()).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it("refuses an invalid alias prefix before creating a local credential", async () => {
  const f = fixture();
  await expect(new LiteLLMGatewayKeys(vi.fn() as typeof fetch).ensure({ ...f.options, aliasPrefix: "installation" }))
    .rejects.toThrow("alias_prefix");
  expect(() => readFileSync(f.secretFile)).toThrow();
});
