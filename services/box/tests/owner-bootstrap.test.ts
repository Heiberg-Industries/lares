import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "owner-bootstrap.py");
const safetyTests = join(dirname(fileURLToPath(import.meta.url)), "owner-bootstrap-safety.py");
function helper<T>(source: string, input: unknown): T {
  const python = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('owner_bootstrap',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request=json.load(sys.stdin)
${source}`;
  return JSON.parse(execFileSync("python3", ["-c", python, script], {
    input: JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }));
}

const identity = { issuer: "https://accounts.google.com", subject: `odd\"subject$HOME$$literal\\\nline`, tenantId: "tenant's exact value" };
const installationOrigin = "https://example.test";
const selection = {
  ownerId: "stable-owner", organisationId: "example.test", installationOrigin, identity,
  digest: createHash("sha256").update(JSON.stringify({ purpose: "lares-owner-bootstrap-v1", ownerId: "stable-owner", organisationId: "example.test", installationOrigin, identity })).digest("hex"),
};

describe("root owner bootstrap config writer", () => {
  it("covers privileged refusal, atomic replacement, timeout cleanup, and competing writers", () => {
    execFileSync("python3", ["-B", safetyTests], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  });

  it("preserves unrelated settings and exact opaque tuple values in the selected env setting", () => {
    const original = "GOOGLE_CLIENT_ID=client\nGOOGLE_CLIENT_SECRET=still-secret\n";
    const result = helper<{ contents: string; already: boolean }>(
      "saved,already=module.env_with_identity(request['contents'].encode(),request['selection'])\nprint(json.dumps({'contents':saved.decode(),'already':already}))",
      { contents: original, selection },
    );
    expect(result.already).toBe(false);
    expect(result.contents.startsWith(original)).toBe(true);
    const encoded = result.contents.split("CONSOLE_BOOTSTRAP_IDENTITY=", 2)[1]!.trim();
    expect(encoded).toBe(JSON.stringify(selection).replaceAll("$", () => "$$"));
    expect(helper<{ already: boolean; contents: string }>(
      "saved,already=module.env_with_identity(request['contents'].encode(),request['selection'])\nprint(json.dumps({'contents':saved.decode(),'already':already}))",
      { contents: result.contents, selection },
    )).toEqual({ contents: result.contents, already: true });
  });

  it("refuses malformed, duplicate, or conflicting bootstrap settings without replacing them", () => {
    const call = (contents: string) => helper<{ contents: string; already: boolean }>(
      "saved,already=module.env_with_identity(request['contents'].encode(),request['selection'])\nprint(json.dumps({'contents':saved.decode(),'already':already}))",
      { contents, selection },
    );
    expect(() => call("CONSOLE_BOOTSTRAP_IDENTITY =bad\n")).toThrow();
    expect(() => call("CONSOLE_BOOTSTRAP_IDENTITY={}\nCONSOLE_BOOTSTRAP_IDENTITY={}\n")).toThrow();
    expect(() => call("CONSOLE_BOOTSTRAP_IDENTITY={\"different\":true}\n")).toThrow();
  });

  it("compares copied authority with persisted owner/domain and Keeper owner", () => {
    const source = "settings=module.read_settings(request['settings'])\nowner,organisation,origin=module.persisted_context(settings,module.read_keeper_owner(request['keeper'].encode()),request['origin'])\nprint(json.dumps({'owner':owner,'organisation':organisation,'origin':origin}))";
    expect(helper<{ owner: string; organisation: string }>(source, {
      settings: "LARES_OWNER_ID='stable-owner'\nLARES_DOMAIN=example.test\n",
      keeper: JSON.stringify({ designatedOwnerId: "stable-owner" }),
      origin: "https://example.test",
    })).toEqual({ owner: "stable-owner", organisation: "example.test", origin: "https://example.test" });
    expect(() => helper(source, {
      settings: "LARES_OWNER_ID=stable-owner\nLARES_OWNER_ID=attacker\nLARES_DOMAIN=example.test\n",
      keeper: JSON.stringify({ designatedOwnerId: "stable-owner" }),
      origin: "https://example.test",
    })).toThrow();
    expect(() => helper(source, {
      settings: "LARES_OWNER_ID=stable-owner\nLARES_DOMAIN=example.test\n",
      keeper: JSON.stringify({ designatedOwnerId: "other-owner" }),
      origin: "https://example.test",
    })).toThrow();
    expect(() => helper(source, {
      settings: "LARES_OWNER_ID=stable-owner\nLARES_DOMAIN=example.test\n",
      keeper: JSON.stringify({ designatedOwnerId: "stable-owner" }),
      origin: "https://other.test",
    })).toThrow();
  });

  it("accepts only a discovery receipt without owner identifiers and binds it to installation origin", () => {
    const digest = createHash("sha256").update(JSON.stringify({ purpose: "lares-owner-discovery-v1", installationOrigin, identity })).digest("hex");
    const raw = JSON.stringify({ installationOrigin, identity, digest });
    const source = "receipt=module.parse_receipt(request['raw'])\nactual=module.receipt_digest(receipt['installationOrigin'],receipt['identity'])\nprint(json.dumps({'receipt':receipt,'digest':actual}))";
    expect(helper<{ receipt: { installationOrigin: string; identity: unknown; digest: string }; digest: string }>(source, { raw })).toEqual({
      receipt: { installationOrigin, identity, digest }, digest,
    });
    expect(() => helper(source, { raw: JSON.stringify(selection) })).toThrow();
    const duplicate = `{"installationOrigin":"${installationOrigin}","installationOrigin":"https://other.test","identity":{},"digest":"${digest}"}`;
    expect(() => helper("module.parse_receipt(request['raw'])\nprint('{}')", { raw: duplicate })).toThrow();
  });

  it.skipIf(process.env.GITHUB_ACTIONS !== "true")("round-trips opaque identifiers through a real Compose container in CI", () => {
    const directory = mkdtempSync(join(tmpdir(), "lares-owner-bootstrap-compose-"));
    try {
      const generated = helper<{ contents: string }>(
        "saved,_=module.env_with_identity(b'',request['selection'])\nprint(json.dumps({'contents':saved.decode()}))",
        { selection },
      );
      writeFileSync(join(directory, "console-oauth.env"), generated.contents);
      writeFileSync(join(directory, "compose.yaml"), [
        "services:", "  console:", "    image: pgvector/pgvector:pg16", "    pull_policy: always",
        "    network_mode: none", "    env_file:", "      - ./console-oauth.env",
        "    entrypoint: [\"/bin/sh\"]",
        "    command: [\"-ec\", \"printf '%s' \\\"$$CONSOLE_BOOTSTRAP_IDENTITY\\\"\"]", "",
      ].join("\n"));
      const actual = execFileSync("docker", ["compose", "--project-directory", directory, "-f", join(directory, "compose.yaml"), "run", "--rm", "--no-deps", "console"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(actual === JSON.stringify(selection)).toBe(true);
      expect(readFileSync(join(directory, "console-oauth.env"), "utf8")).toContain("subject$");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
