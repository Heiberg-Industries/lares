import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayCanonical, gatewayHash } from "@lares/agent-kit/gateway-admission-protocol";
import { GATEWAY_AUTHORITY_STAGE_FILES } from "../bin/render-gateway-authority-stage.js";
import { gatewayAdmissionProfile } from "../lib/gateway-config.js";
import { renderStackCompose } from "../lib/stack-compose.js";
import { parseReleaseManifest } from "../lib/release-manifest.js";
import { renderKeeperComposeEnvironment } from "../bin/render-keeper-config.js";
import { nativeTestPolicy } from "../../keeper/tests/helpers/native-cleanup.js";
import { parseBudgetNativePolicyDocument } from "../../keeper/lib/budget-native-host.js";
import { stageGatewayAuthority } from "../bin/render-gateway-authority-stage.js";

if (typeof process.getuid !== "function" || process.getuid() !== 0) throw new Error("probe must run as root in the disposable CI fixture");

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Protected-source ancestry must be root-owned and non-writable. A normal /tmp root
// directory is world-writable even when its child is private, so the disposable Linux probe
// stays under /run rather than accidentally testing against an unsafe ancestor.
const root = mkdtempSync(join("/run", "lares-gateway-authority-stage-probe-"));
const prefix = join(root, "prefix"), etc = join(prefix, "etc", "lares"), opt = join(prefix, "opt", "lares");
const secrets = join(etc, "secrets"), keeperConfig = join(etc, "keeper.json"), releaseFile = join(root, "release.json");
const stage = join(root, "stage");
const ownerId = "neutral-ci-owner", domain = "example.test", alias = "lares-brain", providerModel = "openai/synthetic-model";
const keyPath = join(secrets, "gateway-budget-service-key"), policyPath = join(etc, "native-policy.json");
const request = { prefix, releaseFile, project: "lares-ci", network: "lares-ci", subnet: "172.30.42.0/24", proxyAddress: "172.30.42.2", pgDatabase: "lares_ci" };
const cli = join(repo, "services", "box", "bin", "render-gateway-authority-stage.ts");
const activePaths = {
  keeperConfig: join(etc, "keeper.json"),
  profile: join(etc, "litellm-config.yaml.profile.json"),
  stack: join(opt, "compose.yaml"),
  keeperCompose: join(opt, "compose.lares-keeper.yaml"),
  keeperEnv: join(etc, "keeper.env"),
};
const writeProtected = (path: string, data: string | Buffer, mode: number) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, data, { mode }); chmodSync(path, mode);
};
const replaceProtectedAtomically = (path: string, data: string | Buffer, mode: number) => {
  const temporary = `${path}.replacement-${process.pid}`;
  writeProtected(temporary, data, mode);
  renameSync(temporary, path);
};
const runCli = (destination = stage) => spawnSync(process.execPath, ["--import", "tsx", cli, destination], {
  cwd: repo, input: `${JSON.stringify(request)}\n`, encoding: "utf8", timeout: 30_000,
});
const activeSnapshot = () => Object.values(activePaths).map(path => [path, readFileSync(path).toString("hex"), statSync(path).mode & 0o777]);
const run = () => {
  mkdirSync(secrets, { recursive: true, mode: 0o700 }); chmodSync(secrets, 0o700);
  const manifest = parseReleaseManifest(JSON.stringify({ release: "ci-neutral", images: Object.fromEntries(
    ["db", "console", "lares-gateway", "caddy", "lares-keeper", "lares-egress-proxy"].map(name => [name, `example.invalid/${name}@sha256:${"a".repeat(64)}`])),
  migrations: { box: "001_baseline.sql" }, breaking: [] }));
  const profile = gatewayAdmissionProfile({ alias, providerModel });
  const basePolicy = nativeTestPolicy();
  const policy = { ...basePolicy, capability: profile, pricing: {
    ...basePolicy.pricing, format: profile.provider,
    capabilityHash: gatewayHash(gatewayCanonical(profile)),
  } };
  const endpointHash = "b".repeat(64);
  const identity = { issuer: "https://accounts.google.com", subject: "neutral-ci-subject" };
  const digestInput = { purpose: "lares-owner-bootstrap-v1", ownerId, organisationId: domain, installationOrigin: `https://${domain}`, identity };
  const bootstrap = { ownerId, organisationId: domain, installationOrigin: `https://${domain}`, identity,
    digest: createHash("sha256").update(JSON.stringify(digestInput)).digest("hex") };
  const settings = [
    `LARES_OWNER_ID=${ownerId}`, `LARES_OWNER_EMAIL=owner@example.test`, `LARES_DOMAIN=${domain}`,
    `LARES_MODEL_ALIAS=${alias}`, `LARES_MODEL=${providerModel}`, `CONSOLE_ALLOWED_EMAILS=owner@example.test`,
    "GATEWAY_URL=http://lares-gateway:4000", "OWNER_HOME_TZ=Europe/Oslo", "",
  ].join("\n");
  const key = Buffer.alloc(32, 0x27);
  const previousKeeper = {
    designatedOwnerId: ownerId, publicDoorOrigin: `https://${domain}`,
    budgetFinancial: { directory: "/var/lib/lares/budget-financial", db: { host: "db", port: 5432, database: "lares_ci", user: "lares_financial", passwordFile: join(secrets, "financial-database-password") } },
    budgetNative: { directory: "/var/lib/lares/budget-native", reviewedPolicyFile: policyPath },
    gatewayBudget: { serviceKeyFile: keyPath },
  };
  writeProtected(releaseFile, `${JSON.stringify(manifest)}\n`, 0o600);
  writeProtected(join(etc, "installation.env"), settings, 0o640);
  writeProtected(join(etc, "console-oauth.env"), `CONSOLE_BOOTSTRAP_IDENTITY=${JSON.stringify(bootstrap).replaceAll("$", "$$")}\n`, 0o600);
  writeProtected(keeperConfig, `${JSON.stringify(previousKeeper)}\n`, 0o600);
  writeProtected(policyPath, `${JSON.stringify({ endpointHash, policies: [policy] })}\n`, 0o600);
  writeProtected(keyPath, key, 0o600);
  for (const name of ["database-password", "financial-database-password", "workflow-provisioner-password", "workflow-password", "gateway-master-key", "gateway-key", "model-provider-key", "gateway-database-password", "console-session-secret", "eve-route-password", "token-enc-key"])
    writeProtected(join(secrets, name), `neutral-ci-${name}\n`, 0o600);
  const egress = join(prefix, "srv", "lares", "egress"); mkdirSync(egress, { recursive: true, mode: 0o755 });
  writeProtected(join(egress, "squid.conf"), "http_port 3128\n", 0o640);

  mkdirSync(opt, { recursive: true, mode: 0o755 });
  const stack = renderStackCompose(manifest, {
    secretsDir: secrets, socketDir: join(prefix, "run", "lares"), tasteDir: join(prefix, "srv", "taste"),
    gatewayConfigFile: join(etc, "litellm-config.yaml"), gatewayStartScript: join(etc, "gateway-start.sh"), caddyfile: join(etc, "Caddyfile"),
    caddyDataDir: join(prefix, "var", "lib", "lares", "caddy"), dbDataDir: join(prefix, "var", "lib", "lares", "postgres"),
    network: request.network, subnet: request.subnet, domain, consoleAllowedEmails: "owner@example.test", ownerId,
    ownerHomeTz: "Europe/Oslo", modelAlias: alias, pgDatabase: request.pgDatabase, deadlineCalendarFile: null,
  });
  const profileText = `${JSON.stringify(profile)}\n`;
  const activeKeeperEnv = renderKeeperComposeEnvironment(manifest, {
    root: join(prefix, "srv", "lares"), keeperConfig, socketDir: join(prefix, "run", "lares"),
    hostSocketDir: join(prefix, "run", "lares-host"), egressDir: join(prefix, "srv", "lares", "egress"),
    secretsDir: secrets, proxyAddress: request.proxyAddress, network: request.network,
  }, previousKeeper as any);
  writeProtected(activePaths.profile, profileText, 0o600);
  writeProtected(activePaths.stack, stack, 0o640);
  writeProtected(activePaths.keeperCompose, readFileSync(join(repo, "services", "box", "compose.lares-keeper.yaml")), 0o640);
  writeProtected(activePaths.keeperEnv, activeKeeperEnv, 0o640);

  const beforeActive = activeSnapshot();
  const first = runCli();
  assert.equal(first.status, 0, "default staging CLI must complete from protected neutral fixtures");
  const stagedNames = readdirSync(stage).sort();
  assert.deepEqual(stagedNames, [".complete.json", "Caddyfile", "compose.lares-keeper.yaml", "compose.yaml", "gateway-start.sh", "gateway-start.sh.admission_contract.py", "gateway-start.sh.lares_gateway.py", "keeper.env", "keeper.json", "litellm-config.yaml", "litellm-config.yaml.profile.json"].sort());
  const completion = JSON.parse(readFileSync(join(stage, ".complete.json"), "utf8"));
  assert.equal(completion.version, 2);
  assert.match(completion.sourceCommitment, /^[a-f0-9]{64}$/);
  assert(!Object.values(completion).includes(key.toString("hex")));
  const stageSnapshot = () => readdirSync(stage).sort().map(name => [name, readFileSync(join(stage, name)).toString("hex"), statSync(join(stage, name)).mode & 0o777]);
  const exactStage = stageSnapshot();

  const configText = execFileSync("docker", ["compose", "--project-name", "lares-authority-probe", "--project-directory", opt,
    "--env-file", join(stage, "keeper.env"), "-f", join(stage, "compose.yaml"), "-f", join(stage, "compose.lares-keeper.yaml"), "config", "--format", "json"], { encoding: "utf8" });
  const resolved = JSON.parse(configText);
  const mounts = (service: string) => resolved.services[service].volumes as any[];
  const covers = (mountPath: unknown, filePath: string) => typeof mountPath === "string" &&
    (mountPath === filePath || mountPath === "/" || filePath.startsWith(`${mountPath.replace(/\/$/, "")}/`));
  const gatewayMounts = mounts("lares-gateway").filter((entry: any) => covers(entry.source, keyPath) || covers(entry.target, "/run/secrets/gateway-budget-service-key"));
  assert.deepEqual(gatewayMounts.map((entry: any) => [entry.source, entry.target, entry.read_only]), [[keyPath, "/run/secrets/gateway-budget-service-key", true]]);
  const keeperMounts = mounts("lares-keeper").filter((entry: any) => [keyPath, policyPath].some(path => covers(entry.source, path) || covers(entry.target, path)));
  assert.deepEqual(keeperMounts.map((entry: any) => [entry.source, entry.target, entry.read_only]).sort(), [[keyPath, keyPath, true], [policyPath, policyPath, true]].sort());
  for (const service of Object.keys(resolved.services).filter(name => !["lares-gateway", "lares-keeper"].includes(name)))
    assert(!mounts(service).some((entry: any) => [keyPath, policyPath, "/run/secrets/gateway-budget-service-key", "/etc/lares/native-policy.json"]
      .some(path => covers(entry.source, path) || covers(entry.target, path))), `${service} must not receive key or reviewed-policy paths`);
  const stagedBytes = Buffer.concat(GATEWAY_AUTHORITY_STAGE_FILES.map(name => readFileSync(join(stage, name))));
  const policyBytes = readFileSync(policyPath);
  assert(!stagedBytes.includes(key));
  assert(!stagedBytes.includes(policyBytes));
  policyBytes.fill(0);
  assert.deepEqual(activeSnapshot(), beforeActive);

  const rerun = runCli();
  assert.equal(rerun.status, 0, "exact default-CLI rerun must validate and no-op");
  assert.deepEqual(stageSnapshot(), exactStage);
  const rejectedStage = join(root, "refused-stage");
  writeProtected(join(etc, "installation.env"), `${settings} LARES_OWNER_ID=ambiguous\n`, 0o640);
  const rejected = runCli(rejectedStage);
  assert.notEqual(rejected.status, 0, "ambiguous selected settings must refuse before stage creation");
  assert(!readdirSync(root).includes("refused-stage"));
  writeProtected(join(etc, "installation.env"), settings, 0o640);
  assert.deepEqual(activeSnapshot(), beforeActive, "validation refusal must leave active render inputs unchanged");

  const profileSentinel = "{\"sentinel\":\"active-render-must-not-be-replaced\"}\n";
  writeProtected(activePaths.profile, profileSentinel, 0o600);
  const sentinelSnapshot = activeSnapshot();
  const profileRefusal = runCli(join(root, "profile-refusal-stage"));
  assert.notEqual(profileRefusal.status, 0, "active rendered profile mismatch must refuse staging");
  assert(!readdirSync(root).includes("profile-refusal-stage"));
  assert.deepEqual(activeSnapshot(), sentinelSnapshot, "profile mismatch refusal must not rewrite active files");
  writeProtected(activePaths.profile, `${JSON.stringify(profile)}\n`, 0o600);

  const partial = join(root, "partial-stage"); mkdirSync(partial, { mode: 0o700 });
  writeProtected(join(partial, "sentinel"), "unknown partial evidence", 0o600);
  assert.notEqual(runCli(partial).status, 0, "unknown partial destination must not be adopted");
  assert.equal(readFileSync(join(partial, "sentinel"), "utf8"), "unknown partial evidence");
  assert.deepEqual(activeSnapshot(), beforeActive);

  const keeperJson = readFileSync(keeperConfig, "utf8");
  writeProtected(keeperConfig, keeperJson.replace('"designatedOwnerId":"neutral-ci-owner"', '"designatedOwnerId":"ambiguous","designatedOwnerId":"neutral-ci-owner"'), 0o600);
  const duplicateKeeperStage = join(root, "duplicate-keeper-json-stage");
  const beforeDuplicateKeeper = activeSnapshot();
  assert.notEqual(runCli(duplicateKeeperStage).status, 0, "duplicate Keeper JSON authority keys must refuse before stage creation");
  assert(!readdirSync(root).includes("duplicate-keeper-json-stage"));
  assert.deepEqual(activeSnapshot(), beforeDuplicateKeeper, "duplicate JSON refusal must not rewrite active inputs");
  writeProtected(keeperConfig, keeperJson, 0o600);

  const keeperEnvPath = activePaths.keeperEnv;
  const keeperEnv = readFileSync(keeperEnvPath, "utf8");
  writeProtected(keeperEnvPath, `${keeperEnv}LARES_NETWORK=ambiguous\n`, 0o640);
  const duplicateEnvStage = join(root, "duplicate-keeper-env-stage");
  const beforeDuplicateEnv = activeSnapshot();
  assert.notEqual(runCli(duplicateEnvStage).status, 0, "duplicate Keeper environment assignments must refuse before stage creation");
  assert(!readdirSync(root).includes("duplicate-keeper-env-stage"));
  assert.deepEqual(activeSnapshot(), beforeDuplicateEnv, "duplicate environment refusal must not rewrite active inputs");
  writeProtected(keeperEnvPath, keeperEnv, 0o640);

  const policyStage = join(root, "policy-replacement-stage");
  assert.equal(runCli(policyStage).status, 0, "a second validated unbound stage may be prepared");
  const policyStageSnapshot = readdirSync(policyStage).sort().map(name => [name, readFileSync(join(policyStage, name)).toString("hex"), statSync(join(policyStage, name)).mode & 0o777]);
  const changedPolicy = { ...policy, pricing: { ...policy.pricing, usdPerMillionTokens: { ...policy.pricing.usdPerMillionTokens, output: "1" } }, maximumLiability: "0.002" };
  const changedPolicyText = `${JSON.stringify({ endpointHash, policies: [changedPolicy] })}\n`;
  assert.doesNotThrow(() => parseBudgetNativePolicyDocument(changedPolicyText), "replacement pricing and maximum liability must remain valid");
  const originalPolicyInode = statSync(policyPath).ino;
  replaceProtectedAtomically(policyPath, changedPolicyText, 0o600);
  assert.notEqual(statSync(policyPath).ino, originalPolicyInode, "policy replacement must use a new inode");
  assert.notEqual(runCli(policyStage).status, 0, "same-capability reviewed-policy replacement must refuse completion reuse");
  assert.deepEqual(readdirSync(policyStage).sort().map(name => [name, readFileSync(join(policyStage, name)).toString("hex"), statSync(join(policyStage, name)).mode & 0o777]), policyStageSnapshot);
  replaceProtectedAtomically(policyPath, `${JSON.stringify({ endpointHash, policies: [policy] })}\n`, 0o600);

  const replacement = Buffer.from(key);
  const keyReplacementStage = join(root, "key-replacement-stage");
  assert.equal(runCli(keyReplacementStage).status, 0, "a fresh validated key snapshot may be staged");
  const keyStageSnapshot = readdirSync(keyReplacementStage).sort().map(name => [name, readFileSync(join(keyReplacementStage, name)).toString("hex"), statSync(join(keyReplacementStage, name)).mode & 0o777]);
  const originalKeyInode = statSync(keyPath).ino;
  replaceProtectedAtomically(keyPath, replacement, 0o600);
  assert.notEqual(statSync(keyPath).ino, originalKeyInode, "same-byte key replacement must use a new inode");
  assert.notEqual(runCli(keyReplacementStage).status, 0, "same-path key inode replacement must refuse completion reuse");
  assert.deepEqual(readdirSync(keyReplacementStage).sort().map(name => [name, readFileSync(join(keyReplacementStage, name)).toString("hex"), statSync(join(keyReplacementStage, name)).mode & 0o777]), keyStageSnapshot);

  const inPlaceKeyStage = join(root, "key-in-place-stage");
  assert.equal(runCli(inPlaceKeyStage).status, 0, "a fresh current key snapshot may be staged after a separate custody change");
  const inPlaceSnapshot = readdirSync(inPlaceKeyStage).sort().map(name => [name, readFileSync(join(inPlaceKeyStage, name)).toString("hex"), statSync(join(inPlaceKeyStage, name)).mode & 0o777]);
  writeFileSync(keyPath, Buffer.alloc(32, 0x29));
  assert.notEqual(runCli(inPlaceKeyStage).status, 0, "same-inode key content edit must refuse completion reuse");
  assert.deepEqual(readdirSync(inPlaceKeyStage).sort().map(name => [name, readFileSync(join(inPlaceKeyStage, name)).toString("hex"), statSync(join(inPlaceKeyStage, name)).mode & 0o777]), inPlaceSnapshot);

  const raceStage = join(root, "source-change-during-stage");
  let writes = 0;
  const racingWriter = (path: string, contents: Buffer, mode: number) => {
    writeFileSync(path, contents, { flag: "wx", mode }); chmodSync(path, mode);
    if (++writes === 2) writeFileSync(keyPath, Buffer.alloc(32, 0x2a));
  };
  assert.throws(() => stageGatewayAuthority(raceStage, request, { writeFile: racingWriter }), /sources changed after validation/);
  assert(readdirSync(raceStage).includes(".incomplete.json"), "source race must leave incomplete, non-adoptable evidence");
  assert(!readdirSync(raceStage).includes(".complete.json"), "source race must never emit a completion marker");
  assert.deepEqual(activeSnapshot(), beforeActive, "source replacement and policy failures must not alter active rendered files");
  key.fill(0); replacement.fill(0); stagedBytes.fill(0);
};

try { run(); }
finally { rmSync(root, { recursive: true, force: true }); }

console.log("Protected staged gateway authority and resolved Compose mount proof passed; no services were started.");
