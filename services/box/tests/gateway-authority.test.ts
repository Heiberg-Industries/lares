import { execFileSync } from "node:child_process";
import { closeSync, fchmodSync, fsyncSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gatewayServiceKeyMetadataIsSafe, parseConfirmedBootstrapSelection, parseInstallationSettings } from "../lib/gateway-authority.js";
import { assertExistingRenderedAuthorityText, GATEWAY_AUTHORITY_STAGE_FILES, parseStageEnvironment, stageGatewayAuthority } from "../bin/render-gateway-authority-stage.js";
import { gatewayAdmissionProfile } from "../lib/gateway-config.js";
import { parseReleaseManifest } from "../lib/release-manifest.js";
import { renderKeeperComposeEnvironment } from "../bin/render-keeper-config.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("staged gateway authority source parsing", () => {
  it("matches the root bootstrap writer digest and decodes only Compose dollar escapes", () => {
    const identity = {
      issuer: "https://accounts.google.com",
      subject: "odd\"subject$HOME$$literal\n snowman ☃",
      tenantId: "tenant$one",
    };
    const payload = {
      purpose: "lares-owner-bootstrap-v1",
      ownerId: "stable-owner",
      organisationId: "example.test",
      installationOrigin: "https://example.test",
      identity,
    };
    const expectedDigest = execFileSync("python3", ["-c", "import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.load(sys.stdin),ensure_ascii=False,separators=(',',':')).encode()).hexdigest())"], {
      input: JSON.stringify(payload), encoding: "utf8",
    }).trim();
    const selection = { ownerId: payload.ownerId, organisationId: payload.organisationId, installationOrigin: payload.installationOrigin, identity, digest: expectedDigest };
    const line = `CONSOLE_BOOTSTRAP_IDENTITY=${JSON.stringify(selection).replaceAll("$", () => "$$")}`;
    expect(parseConfirmedBootstrapSelection(`${line}\n`)).toEqual({
      ownerId: payload.ownerId,
      organisationId: payload.organisationId,
      installationOrigin: payload.installationOrigin,
    });
  });

  it("rejects duplicate assignments, JSON keys, and noncanonical origins", () => {
    const good = {
      ownerId: "stable-owner", organisationId: "example.test", installationOrigin: "https://example.test",
      identity: { issuer: "https://accounts.google.com", subject: "subject" }, digest: "a".repeat(64),
    };
    expect(() => parseConfirmedBootstrapSelection(`CONSOLE_BOOTSTRAP_IDENTITY=${JSON.stringify(good)}\nCONSOLE_BOOTSTRAP_IDENTITY=${JSON.stringify(good)}\n`)).toThrow();
    expect(() => parseConfirmedBootstrapSelection('CONSOLE_BOOTSTRAP_IDENTITY={"ownerId":"a","ownerId":"b"}\n')).toThrow();
    const invalid = { ...good, installationOrigin: "https://example.test/path" };
    expect(() => parseConfirmedBootstrapSelection(`CONSOLE_BOOTSTRAP_IDENTITY=${JSON.stringify(invalid)}\n`)).toThrow();
  });

  it("reads installation settings as data and refuses repeated or malformed authority inputs", () => {
    const settings = parseInstallationSettings([
      "LARES_OWNER_ID='owner'\\''s'",
      "LARES_OWNER_EMAIL=owner@example.test",
      "LARES_DOMAIN=example.test",
      "LARES_MODEL_ALIAS=lares-brain",
      "LARES_MODEL=anthropic/claude-sonnet-4-5",
      "CONSOLE_ALLOWED_EMAILS=owner@example.test",
      "GATEWAY_URL=http://lares-gateway:4000",
      "OWNER_HOME_TZ=Europe/Oslo",
    ].join("\n"));
    expect(settings.LARES_OWNER_ID).toBe("owner's");
    expect(settings.LARES_DOMAIN).toBe("example.test");
    expect(() => parseInstallationSettings("LARES_OWNER_ID=owner\nLARES_OWNER_ID=other\n")).toThrow();
    expect(() => parseInstallationSettings(" LARES_OWNER_ID=owner\nLARES_DOMAIN=example.test\n")).toThrow();
    expect(() => parseInstallationSettings("LARES_OWNER_ID =owner\nLARES_DOMAIN=example.test\n")).toThrow();
    expect(() => parseInstallationSettings("LARES_OWNER_ID\t=owner\nLARES_DOMAIN=example.test\n")).toThrow();
    expect(() => parseInstallationSettings("LARES_OWNER_ID=\nLARES_DOMAIN=example.test\n")).toThrow();
    expect(() => parseInstallationSettings("LARES_OWNER_ID=owner\nLARES_DOMAIN=bad domain\n")).toThrow();
  });

  it("accepts only a root-owned, mode 0600, single-link raw 32-byte key file", () => {
    const safe = { isFile: () => true, uid: 0, gid: 0, nlink: 1, mode: 0o100600, size: 32 };
    expect(gatewayServiceKeyMetadataIsSafe(safe)).toBe(true);
    for (const invalid of [
      { ...safe, size: 31 }, { ...safe, size: 33 }, { ...safe, mode: 0o100640 },
      { ...safe, mode: 0o104600 },
      { ...safe, uid: 1000 }, { ...safe, gid: 1000 }, { ...safe, nlink: 2 },
      { ...safe, isFile: () => false },
    ]) expect(gatewayServiceKeyMetadataIsSafe(invalid)).toBe(false);
  });
});

describe("staged gateway authority transaction", () => {
  const profile = gatewayAdmissionProfile({ alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5" });
  const authority = {
    origin: "https://example.test", endpointHash: "a".repeat(64),
    serviceKeyFile: "/srv/lares/etc/lares/secrets/gateway-budget-service-key",
    policyFile: "/srv/lares/etc/lares/native-policy.json", profile,
  };
  const keeperComposeEnvironment = [
    "LARES_KEEPER_IMAGE=example.invalid/keeper@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "LARES_SQUID_IMAGE=example.invalid/squid@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "LARES_ROOT=/srv/lares/srv/lares", "LARES_KEEPER_CONFIG=/srv/lares/etc/lares/keeper.json",
    "LARES_DATABASE_PASSWORD_FILE=/srv/lares/etc/lares/secrets/database-password",
    "LARES_FINANCIAL_DATABASE_PASSWORD_FILE=/srv/lares/etc/lares/secrets/financial-database-password",
    "LARES_WORKFLOW_PROVISIONER_PASSWORD_FILE=/srv/lares/etc/lares/secrets/workflow-provisioner-password",
    "LARES_WORKFLOW_RUNTIME_PASSWORD_FILE=/srv/lares/etc/lares/secrets/workflow-password",
    "LARES_GATEWAY_MASTER_KEY_FILE=/srv/lares/etc/lares/secrets/gateway-master-key",
    "LARES_EVE_ROUTE_PASSWORD_FILE=/srv/lares/etc/lares/secrets/eve-route-password",
    "LARES_VAULT_SIGNING_KEY_FILE=/srv/lares/etc/lares/secrets/console-vault-signing-key",
    "LARES_OUTSIDE_CUSTODY_PASSWORD_FILE=/srv/lares/etc/lares/secrets/outside-custody-database-password",
    "LARES_SOCKET_DIR=/srv/lares/run/lares", "LARES_HOST_SOCKET_DIR=/srv/lares/run/lares-host",
    "LARES_EGRESS_DIR=/srv/lares/srv/lares/egress", "LARES_PROXY_ADDRESS=172.29.0.2", "LARES_NETWORK=lares",
  ].join("\n") + "\n";
  const boundOutputs = () => ({
    profile: `${JSON.stringify(profile)}\n`,
    stack: `services:\n  lares-gateway:\n    environment:\n      LARES_GATEWAY_ADMISSION_URL: https://example.test\n      LARES_GATEWAY_ENDPOINT_HASH: ${authority.endpointHash}\n      LARES_GATEWAY_SERVICE_KEY_FILE: /run/secrets/gateway-budget-service-key\n    volumes:\n      - /srv/lares/etc/lares/litellm-config.yaml.profile.json:/etc/litellm/profile.json:ro\n      - type: bind\n        source: ${authority.serviceKeyFile}\n        target: /run/secrets/gateway-budget-service-key\n        read_only: true\n        bind:\n          create_host_path: false\n`,
    keeperCompose: "services:\n  lares-keeper:\n    volumes:\n      - type: bind\n        source: ${LARES_GATEWAY_BUDGET_SERVICE_KEY_FILE:-/dev/null}\n        target: ${LARES_GATEWAY_BUDGET_SERVICE_KEY_TARGET:-/run/secrets/gateway-budget-unused-key}\n        read_only: true\n        bind:\n          create_host_path: false\n      - type: bind\n        source: ${LARES_NATIVE_POLICY_FILE:-/dev/null}\n        target: ${LARES_NATIVE_POLICY_TARGET:-/etc/lares/native-policy-unused.json}\n        read_only: true\n        bind:\n          create_host_path: false\n",
    keeperEnv: `${keeperComposeEnvironment}LARES_GATEWAY_BUDGET_SERVICE_KEY_FILE=${authority.serviceKeyFile}\nLARES_NATIVE_POLICY_FILE=${authority.policyFile}\nLARES_GATEWAY_BUDGET_SERVICE_KEY_TARGET=${authority.serviceKeyFile}\nLARES_NATIVE_POLICY_TARGET=${authority.policyFile}\n`,
  });
  const unboundOutputs = () => ({
    profile: `${JSON.stringify(profile)}\n`,
    stack: "services:\n  lares-gateway:\n    environment: {}\n    volumes:\n      - /srv/lares/etc/lares/litellm-config.yaml.profile.json:/etc/litellm/profile.json:ro\n",
    keeperCompose: "services:\n  lares-keeper:\n    volumes:\n      - type: bind\n        source: ${LARES_GATEWAY_BUDGET_SERVICE_KEY_FILE:-/dev/null}\n        target: ${LARES_GATEWAY_BUDGET_SERVICE_KEY_TARGET:-/run/secrets/gateway-budget-unused-key}\n        read_only: true\n        bind:\n          create_host_path: false\n      - type: bind\n        source: ${LARES_NATIVE_POLICY_FILE:-/dev/null}\n        target: ${LARES_NATIVE_POLICY_TARGET:-/etc/lares/native-policy-unused.json}\n        read_only: true\n        bind:\n          create_host_path: false\n",
    keeperEnv: keeperComposeEnvironment,
  });
  const request = {
    prefix: "/srv/lares", releaseFile: "/srv/lares/release.json", project: "lares", network: "lares",
    subnet: "172.29.0.0/24", proxyAddress: "172.29.0.2", pgDatabase: "lares",
  };
  const fakeFiles = () => new Map(GATEWAY_AUTHORITY_STAGE_FILES.map(name => [name, {
    contents: Buffer.from(name === "keeper.json" ? "{}\n" : `${name}\n`),
    mode: name === "keeper.json" ? 0o600 : name === "compose.yaml" || name === "keeper.env" ? 0o640 : name === "gateway-start.sh" ? 0o755 : 0o644,
  }]));
  const seams = (buildOutputs = fakeFiles, writeFile?: (path: string, data: Buffer, mode: number) => void, recheckSources = () => {}) => ({
    buildOutputs: () => ({ files: buildOutputs(), sourceCommitment: "a".repeat(64), recheckSources }),
    validateDestination: () => {}, acceptExistingDirectory: () => true,
    ...(writeFile ? { writeFile } : {}),
  });

  it("requires an existing bound render to match the exact profile and both authority mounts", () => {
    const existing = boundOutputs();
    expect(() => assertExistingRenderedAuthorityText(existing, authority)).not.toThrow();
    expect(() => assertExistingRenderedAuthorityText(unboundOutputs(), authority)).not.toThrow();
    expect(() => assertExistingRenderedAuthorityText({ ...existing, profile: "{}\n" }, authority)).toThrow(/profile differs/);
    expect(() => assertExistingRenderedAuthorityText({ ...existing, stack: existing.stack.replace(authority.endpointHash, "b".repeat(64)) }, authority)).toThrow(/differs/);
    expect(() => assertExistingRenderedAuthorityText({ ...existing, keeperEnv: existing.keeperEnv.replace("LARES_NATIVE_POLICY_TARGET=", "") }, authority)).toThrow();
    const gatewayParentMount = { ...existing, stack: existing.stack.replace(
      `      - type: bind\n        source: ${authority.serviceKeyFile}\n        target: /run/secrets/gateway-budget-service-key\n        read_only: true\n        bind:\n          create_host_path: false\n`,
      `      - type: bind\n        source: /srv/lares/etc/lares/secrets\n        target: /run/secrets\n        read_only: true\n        bind:\n          create_host_path: false\n`) };
    expect(() => assertExistingRenderedAuthorityText(gatewayParentMount, authority)).toThrow();
    const otherServiceMount = { ...existing, stack: existing.stack.replace("services:\n", `services:\n  console:\n    volumes:\n      - type: bind\n        source: /srv/lares/etc/lares/secrets\n        target: /secrets\n        read_only: true\n        bind:\n          create_host_path: false\n`) };
    expect(() => assertExistingRenderedAuthorityText(otherServiceMount, authority)).toThrow(/non-exact mount/);
    const conflictingTarget = { ...existing, stack: existing.stack.replace("services:\n", `services:\n  console:\n    volumes:\n      - type: bind\n        source: /tmp/unrelated\n        target: /run/secrets\n        read_only: true\n        bind:\n          create_host_path: false\n`) };
    expect(() => assertExistingRenderedAuthorityText(conflictingTarget, authority)).toThrow(/non-exact mount/);
    const secretExposure = { ...existing, stack: existing.stack.replace("services:\n", `secrets:\n  leaked-authority:\n    file: ${authority.serviceKeyFile}\nservices:\n`) };
    expect(() => assertExistingRenderedAuthorityText(secretExposure, authority)).toThrow(/file secret/);
    const configExposure = { ...existing, stack: existing.stack.replace("services:\n", `configs:\n  leaked-authority:\n    file: ${authority.serviceKeyFile}\nservices:\n`) };
    expect(() => assertExistingRenderedAuthorityText(configExposure, authority)).toThrow(/file config/);
    const customPolicy = "/srv/lares/etc/lares/reviewed/custom-native.json";
    const customPolicyExposure = {
      ...existing,
      stack: existing.stack.replace("services:\n", `services:\n  console:\n    volumes:\n      - type: bind\n        source: /srv/lares/etc/lares/reviewed\n        target: /reviewed\n        read_only: true\n        bind:\n          create_host_path: false\n`),
      keeperEnv: existing.keeperEnv.replaceAll(authority.policyFile, customPolicy),
    };
    expect(() => assertExistingRenderedAuthorityText(customPolicyExposure, { ...authority, policyFile: customPolicy })).toThrow(/non-exact mount/);
    expect(() => parseStageEnvironment("A=one\nA=two\n")).toThrow(/ambiguous/);
  });

  it("resolves required Compose interpolation before splitting the committed Keeper template mounts", () => {
    const actualTemplate = {
      ...unboundOutputs(),
      keeperCompose: readFileSync(join(here, "..", "compose.lares-keeper.yaml"), "utf8"),
      keeperEnv: `${keeperComposeEnvironment}LARES_MAINTENANCE_ADMISSION_DIR=/srv/lares/var/lib/lares-maintenance/admission\n` +
        "LARES_MAINTENANCE_INSTALLATION_ID=11111111-1111-4111-8111-111111111111\n" +
        "LARES_MAINTENANCE_EPOCH=1\n",
    };
    expect(() => assertExistingRenderedAuthorityText(actualTemplate, authority)).not.toThrow();
    const missingRequired = { ...actualTemplate, keeperEnv: actualTemplate.keeperEnv.replace(/^LARES_ROOT=.*\n/m, "") };
    expect(() => assertExistingRenderedAuthorityText(missingRequired, authority)).toThrow(/required variable/);
  });

  it("accepts the environment produced by the real Keeper renderer", () => {
    const manifest = parseReleaseManifest(JSON.stringify({
      release: "neutral-test",
      images: Object.fromEntries(["db", "console", "lares-gateway", "caddy", "lares-keeper", "lares-egress-proxy"]
        .map(name => [name, `example.invalid/${name}@sha256:${"a".repeat(64)}`])),
      migrations: { box: "001_baseline.sql" }, breaking: [],
    }));
    const envText = renderKeeperComposeEnvironment(manifest, {
      root: "/srv/lares/srv/lares", keeperConfig: "/srv/lares/etc/lares/keeper.json",
      socketDir: "/srv/lares/run/lares", hostSocketDir: "/srv/lares/run/lares-host",
      egressDir: "/srv/lares/srv/lares/egress", secretsDir: "/srv/lares/etc/lares/secrets",
      proxyAddress: "172.29.0.2", network: "lares",
      maintenanceAdmission: {
        directory: "/srv/lares/var/lib/lares-maintenance/admission",
        installationId: "11111111-1111-4111-8111-111111111111", epoch: 1,
      },
    }, { lifecycle: { maintenanceAdmission: {
      hostDirectory: "/srv/lares/var/lib/lares-maintenance/admission",
      installationId: "11111111-1111-4111-8111-111111111111", epoch: 1,
    } } } as Parameters<typeof renderKeeperComposeEnvironment>[2]);
    const env = parseStageEnvironment(envText);
    expect(env.LARES_ROOT).toBe("/srv/lares/srv/lares");
    expect(env.LARES_MAINTENANCE_ADMISSION_DIR).toBe("/srv/lares/var/lib/lares-maintenance/admission");
    expect(env.LARES_MAINTENANCE_INSTALLATION_ID).toBe("11111111-1111-4111-8111-111111111111");
    expect(env.LARES_MAINTENANCE_EPOCH).toBe("1");
  });

  it("refuses dotenv quoting, comments, whitespace, and escape or interpolation syntax", () => {
    for (const value of [
      "'/srv/lares/etc/lares/secrets'",
      '"/srv/lares/etc/lares/secrets"',
      "/srv/lares/etc/lares/secrets # host custody",
      " /srv/lares/etc/lares/secrets",
      "/srv/lares/etc/lares/secrets ",
      "$${LARES_ROOT}",
      "\\${LARES_ROOT}",
    ]) {
      const existing = {
        ...unboundOutputs(),
        keeperEnv: `${keeperComposeEnvironment}LEAK=${value}\n`,
        stack: `${unboundOutputs().stack}  console:\n    volumes:\n      - type: bind\n        source: \${LEAK}\n        target: /leak\n        read_only: true\n`,
      };
      expect(() => assertExistingRenderedAuthorityText(existing, authority), value).toThrow(/noncanonical/);
    }
  });

  it("refuses Compose include and extends sources in both documents", () => {
    const baseOutputs = unboundOutputs();
    const variants = [
      { ...baseOutputs, stack: `include:\n  - ./external.yaml\n${baseOutputs.stack}` },
      { ...baseOutputs, keeperCompose: `include:\n  - ./external.yaml\n${baseOutputs.keeperCompose}` },
      { ...baseOutputs, stack: `extends:\n  file: ./external.yaml\n${baseOutputs.stack}` },
      { ...baseOutputs, stack: baseOutputs.stack.replace("services:\n", "services:\n  console:\n    extends:\n      file: ./external.yaml\n      service: exposed\n") },
      { ...baseOutputs, keeperCompose: baseOutputs.keeperCompose.replace("  lares-keeper:\n", "  lares-keeper:\n    extends:\n      file: ./external.yaml\n      service: exposed\n") },
    ];
    for (const existing of variants) expect(() => assertExistingRenderedAuthorityText(existing, authority)).toThrow(/include|extends/);
  });

  it("refuses service volumes_from in both documents, including empty or malformed values", () => {
    const bound = boundOutputs();
    expect(() => assertExistingRenderedAuthorityText({
      ...bound,
      stack: `${bound.stack}  console:\n    volumes_from:\n      - lares-gateway:ro\n`,
    }, authority)).toThrow(/volumes_from/);

    const variants = [
      { ...bound, stack: `${bound.stack}  console:\n    volumes_from: []\n` },
      { ...bound, stack: `${bound.stack}  console:\n    volumes_from: invalid\n` },
      { ...bound, keeperCompose: bound.keeperCompose.replace("  lares-keeper:\n", "  lares-keeper:\n    volumes_from: null\n") },
      { ...bound, keeperCompose: bound.keeperCompose.replace("  lares-keeper:\n", "  lares-keeper:\n    volumes_from: {}\n") },
    ];
    for (const existing of variants)
      expect(() => assertExistingRenderedAuthorityText(existing, authority)).toThrow(/volumes_from/);
  });

  it("refuses unresolved binds and named local volumes that could expose protected directories", () => {
    const unresolved = {
      ...unboundOutputs(),
      stack: `${unboundOutputs().stack}  console:\n    volumes:\n      - type: bind\n        source: \${LEAK}\n        target: /leak\n        read_only: true\n`,
    };
    expect(() => assertExistingRenderedAuthorityText(unresolved, authority)).toThrow(/unresolved/);

    const interpolatedLeak = {
      ...unboundOutputs(),
      keeperEnv: `${keeperComposeEnvironment}LEAK=/srv/lares/etc/lares/secrets\n`,
      stack: `${unboundOutputs().stack}  console:\n    volumes:\n      - type: bind\n        source: \${LEAK}\n        target: /leak\n        read_only: true\n`,
    };
    expect(() => assertExistingRenderedAuthorityText(interpolatedLeak, authority)).toThrow(/non-exact mount/);

    const namedBind = {
      ...unboundOutputs(),
      stack: `${unboundOutputs().stack}  console:\n    volumes:\n      - leaked:/leak:ro\nvolumes:\n  leaked:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: /srv/lares/etc/lares/secrets\n`,
    };
    expect(() => assertExistingRenderedAuthorityText(namedBind, authority)).toThrow(/named-volume/);
  });

  it("computes before stage creation, writes a fixed allowlist, and exact reruns revalidate outputs", () => {
    const base = mkdtempSync(join(tmpdir(), "lares-authority-stage-test-"));
    try {
      const activeSentinel = join(base, "active-sentinel");
      writeFileSync(activeSentinel, "unchanged");
      const stage = join(base, "stage");
      expect(() => stageGatewayAuthority(stage, request, seams(() => { throw new Error("preflight refused"); }))).toThrow(/preflight refused/);
      expect(readdirSync(base)).toEqual(["active-sentinel"]);
      expect(readFileSync(activeSentinel, "utf8")).toBe("unchanged");

      let validations = 0;
      const build = () => { validations++; return fakeFiles(); };
      expect(stageGatewayAuthority(stage, request, seams(build))).toBe("written");
      expect(stageGatewayAuthority(stage, request, seams(build))).toBe("unchanged");
      expect(validations).toBe(2);
      expect(readdirSync(stage).sort()).toEqual([...GATEWAY_AUTHORITY_STAGE_FILES, ".complete.json"].sort());
      expect(statSync(join(stage, "keeper.json")).mode & 0o777).toBe(0o600);
      const marker = JSON.parse(readFileSync(join(stage, ".complete.json"), "utf8")) as { version: number; sourceCommitment: string; hashes: string[] };
      expect(Object.keys(marker).sort()).toEqual(["hashes", "sourceCommitment", "version"]);
      expect(marker.version).toBe(2);
      expect(marker.sourceCommitment).toBe("a".repeat(64));
      expect(marker.hashes).toHaveLength(GATEWAY_AUTHORITY_STAGE_FILES.length);
      expect(GATEWAY_AUTHORITY_STAGE_FILES).not.toContain("console-oauth.env");
      expect(GATEWAY_AUTHORITY_STAGE_FILES).not.toContain("native-policy.json");
      expect(GATEWAY_AUTHORITY_STAGE_FILES).not.toContain("gateway-budget-service-key");

      expect(() => stageGatewayAuthority(stage, request, seams(() => {
        const files = fakeFiles(); files.get("compose.yaml")!.contents = Buffer.from("changed\n"); return files;
      }))).toThrow(/does not match current validated inputs/);
      let rechecks = 0;
      const dynamic = (commitment: string) => ({
        buildOutputs: () => ({ files: fakeFiles(), sourceCommitment: commitment, recheckSources: () => { rechecks++; } }),
        validateDestination: () => {}, acceptExistingDirectory: () => true,
      });
      expect(() => stageGatewayAuthority(stage, request, dynamic("b".repeat(64)))).toThrow(/does not match current validated inputs/);
      expect(rechecks).toBe(1);
      const failedSourceRecheck = join(base, "source-changed");
      let recheckCount = 0;
      expect(() => stageGatewayAuthority(failedSourceRecheck, request, seams(fakeFiles, undefined, () => {
        if (++recheckCount === 2) throw new Error("source changed");
      }))).toThrow(/source changed/);
      expect(readdirSync(failedSourceRecheck)).toContain(".incomplete.json");
      expect(readdirSync(failedSourceRecheck)).not.toContain(".complete.json");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("refuses unknown partial stages and leaves explicit incomplete evidence after a write failure", () => {
    const base = mkdtempSync(join(tmpdir(), "lares-authority-stage-failure-"));
    try {
      const partial = join(base, "partial");
      mkdirSync(partial, { mode: 0o700 });
      writeFileSync(join(partial, "unexpected"), "partial");
      expect(() => stageGatewayAuthority(partial, request, seams())).toThrow(/incomplete or contains unknown files/);

      const failedMarker = join(base, "incomplete-marker-failed-once");
      let markerAttempts = 0;
      const failFirstIncompleteWrite = (path: string, data: Buffer, mode: number) => {
        if (++markerAttempts === 1) throw new Error("simulated initial incomplete-marker write failure");
        const fd = openSync(path, "wx", mode);
        try { fchmodSync(fd, mode); writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      };
      expect(() => stageGatewayAuthority(failedMarker, request, seams(fakeFiles, failFirstIncompleteWrite))).toThrow(/initial incomplete-marker write failure/);
      expect(readdirSync(failedMarker)).toEqual([".incomplete.json"]);
      expect(() => stageGatewayAuthority(failedMarker, request, seams())).toThrow(/incomplete or contains unknown files/);

      const failed = join(base, "failed");
      let writes = 0;
      const failAfterFirstOutput = (path: string, data: Buffer, mode: number) => {
        if (++writes === 3) throw new Error("simulated stage write failure");
        const fd = openSync(path, "wx", mode);
        try { fchmodSync(fd, mode); writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      };
      expect(() => stageGatewayAuthority(failed, request, seams(fakeFiles, failAfterFirstOutput))).toThrow(/simulated stage write failure/);
      expect(readdirSync(failed).sort()).toEqual([".incomplete.json", "Caddyfile"].sort());
      expect(() => stageGatewayAuthority(failed, request, seams())).toThrow(/incomplete or contains unknown files/);

      const markerFailed = join(base, "marker-failed");
      let markerWrites = 0;
      const failCompletionMarker = (path: string, data: Buffer, mode: number) => {
        if (++markerWrites === GATEWAY_AUTHORITY_STAGE_FILES.length + 2) throw new Error("simulated completion marker failure");
        const fd = openSync(path, "wx", mode);
        try { fchmodSync(fd, mode); writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      };
      expect(() => stageGatewayAuthority(markerFailed, request, seams(fakeFiles, failCompletionMarker))).toThrow(/simulated completion marker failure/);
      expect(readdirSync(markerFailed)).toContain(".incomplete.json");
      expect(readdirSync(markerFailed)).not.toContain(".complete.json");
      expect(() => stageGatewayAuthority(markerFailed, request, seams())).toThrow(/incomplete or contains unknown files/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
