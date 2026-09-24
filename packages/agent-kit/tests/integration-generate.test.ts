import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderConnectionsModule,
  renderIntegrationSecretsModule,
  integrationSecretBindings,
  GENERATED_BANNER,
  GENERATED_SECRETS_BANNER,
  type InstallationConnections,
} from "../src/integration-generate.js";
import { loadIntegrationManifests } from "../src/integration-manifest.js";
import { KNOWN_CAPABILITIES } from "../src/manifest.js";
import { connectionsByCapability, connections, secretsForRefs } from "../src/connections.js";
import { INTEGRATION_SECRET_FILES } from "../src/integration-secrets.js";

// The repo root, from this file — never a cwd-relative path: vitest is run from several
// directories and `integrations/` lives at the root.
const ROOT = join(import.meta.dirname, "..", "..", "..");
const SRC = join(import.meta.dirname, "..", "src", "connections.ts");
const SECRETS_SRC = join(import.meta.dirname, "..", "src", "integration-secrets.ts");

const installation = JSON.parse(
  readFileSync(join(ROOT, "integrations", "installation.json"), "utf8"),
) as InstallationConnections;

const render = (): string =>
  renderConnectionsModule(
    loadIntegrationManifests(join(ROOT, "integrations")),
    installation,
    KNOWN_CAPABILITIES,
  );

describe("the generated connections module", () => {
  it("reproduces the committed file byte for byte — a stale file fails here, not on a box", () => {
    expect(render()).toBe(readFileSync(SRC, "utf8"));
  });

  it("says on its first line that it is generated, and by what", () => {
    expect(readFileSync(SRC, "utf8").startsWith(GENERATED_BANNER)).toBe(true);
    expect(GENERATED_BANNER).toMatch(/pnpm -C packages\/agent-kit run generate:connections/);
  });

  it("gives EVERY known capability a line, which is what closes the missing `memory` hole", () => {
    for (const c of KNOWN_CAPABILITIES) {
      expect(connectionsByCapability[c], `${c} has no connectionsByCapability entry`).toBeDefined();
    }
  });

  it("never invents a connection a manifest did not declare", () => {
    const rendered = renderConnectionsModule(
      [],
      { connections: [], capabilities: {}, consumers: [] },
      [],
    );
    expect(rendered).toContain("const defs: ConnectionDef[] = [];");
    expect(rendered).not.toContain("notion");
  });

  it("refuses to render when a manifest has no connection at all", () => {
    const manifests = loadIntegrationManifests(join(ROOT, "integrations"));
    const without = {
      ...installation,
      connections: installation.connections.filter((c) => c.id !== "notion"),
      capabilities: {},
      consumers: [],
    };
    expect(() => renderConnectionsModule(manifests, without, KNOWN_CAPABILITIES)).toThrow(
      /integrations\/notion\/integration.json has no connection/,
    );
  });

  it("refuses to render when a manifest's declared secrets are not the ones the box mounts", () => {
    const manifests = loadIntegrationManifests(join(ROOT, "integrations"));
    const moved = {
      ...installation,
      connections: installation.connections.map((c) =>
        c.id === "notion" ? { ...c, instances: [{ id: "shared", secrets: ["notion-tokne"] }] } : c,
      ),
      capabilities: {},
      consumers: [],
    };
    expect(() => renderConnectionsModule(manifests, moved, KNOWN_CAPABILITIES)).toThrow(
      /notion declares secrets \[notion-token\].*\[notion-tokne\]/s,
    );
  });

  it("keeps the connection refs and secret names the console and the keeper already read", () => {
    // The whole point of generating this file is that no VALUE moves. These are the ones a
    // consumer binds to: a secret file name the box mounts, and a ref the console parses.
    expect(secretsForRefs(["notion"])).toEqual(["notion-token"]);
    expect(secretsForRefs(["gateway:shared"])).toEqual(["gateway-key"]);
    expect(connectionsByCapability.gmail).toEqual(["google"]);
    expect(connectionsByCapability.calendar).toEqual(["google"]);
    expect(connectionsByCapability.twenty).toEqual(["twenty"]);
    expect(connectionsByCapability.studio).toEqual(["gateway:shared"]);
    expect(connectionsByCapability.commercial).toEqual(["twenty", "gateway:shared", "orakel"]);
    expect([...connections.keys()].sort()).toEqual(
      ["aerodatabox", "gateway", "google", "karakeep", "notion", "orakel", "places",
       "readability", "signals", "slack", "strava", "telegram", "twenty"],
    );
  });
});

// LAR-76: the keeper used to keep its OWN hand-written map of which secret files it may mount,
// and the two lists disagreed in both directions. The same source and the same command now write
// both, so the disagreement has nowhere left to live.
describe("the generated integration-secrets module", () => {
  it("reproduces the committed file byte for byte — a stale file fails here, not on a box", () => {
    expect(renderIntegrationSecretsModule(installation)).toBe(readFileSync(SECRETS_SRC, "utf8"));
  });

  it("says on its first line that it is generated, and by what", () => {
    expect(readFileSync(SECRETS_SRC, "utf8").startsWith(GENERATED_SECRETS_BANNER)).toBe(true);
    expect(GENERATED_SECRETS_BANNER).toMatch(/pnpm -C packages\/agent-kit run generate:connections/);
  });

  it("mounts the Google client pair under the names the box and the readers both use", () => {
    // The one VALUE change LAR-76 makes: the keeper said `travel-google-client-id` /
    // `travel-google-client-secret`, which is on no box and in no other file. Both services that
    // read these variables already fall back to the names below when the variable is unset.
    expect(INTEGRATION_SECRET_FILES.GOOGLE_CLIENT_ID_HEIBERG_FILE).toBe("google-client-id-heiberg");
    expect(INTEGRATION_SECRET_FILES.GOOGLE_CLIENT_SECRET_HEIBERG_FILE).toBe("google-client-secret-heiberg");
  });

  it("only ever names a secret its own connection instance declares", () => {
    const declared = new Set<string>();
    for (const def of connections.values()) for (const i of def.instances) for (const s of i.secrets) declared.add(s);
    for (const file of Object.values(INTEGRATION_SECRET_FILES)) expect(declared.has(file), file).toBe(true);
  });

  it("refuses an env key for a secret the instance does not have", () => {
    const bad: InstallationConnections = {
      connections: [{ id: "notion", label: "n", custody: "host",
        instances: [{ id: "shared", secrets: ["notion-token"], secretEnv: { "other-token": "OTHER_FILE" } }] }],
      capabilities: {}, consumers: [],
    };
    expect(() => integrationSecretBindings(bad)).toThrow(/not one of that instance's secrets/);
  });

  it("refuses a half-declared instance — every secret of it needs an env key, or none does", () => {
    const half: InstallationConnections = {
      connections: [{ id: "pair", label: "p", custody: "host",
        instances: [{ id: "shared", secrets: ["a-id", "a-secret"], secretEnv: { "a-id": "A_ID_FILE" } }] }],
      capabilities: {}, consumers: [],
    };
    expect(() => integrationSecretBindings(half)).toThrow(/half a credential pair/);
  });

  it("refuses the same env key on two instances — one variable cannot carry two credentials", () => {
    const twice: InstallationConnections = {
      connections: [
        { id: "one", label: "1", custody: "host",
          instances: [{ id: "shared", secrets: ["one-key"], secretEnv: { "one-key": "SHARED_FILE" } }] },
        { id: "two", label: "2", custody: "host",
          instances: [{ id: "shared", secrets: ["two-key"], secretEnv: { "two-key": "SHARED_FILE" } }] },
      ],
      capabilities: {}, consumers: [],
    };
    expect(() => integrationSecretBindings(twice)).toThrow(/binds "SHARED_FILE" twice/);
  });

  it("refuses a secret file name that would not stay inside the secrets directory", () => {
    const escape: InstallationConnections = {
      connections: [{ id: "bad", label: "b", custody: "host",
        instances: [{ id: "shared", secrets: ["../etc/shadow"], secretEnv: { "../etc/shadow": "BAD_FILE" } }] }],
      capabilities: {}, consumers: [],
    };
    expect(() => integrationSecretBindings(escape)).toThrow(/not a plain lowercase name/);
  });
});
