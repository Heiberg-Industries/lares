import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseReleaseManifest } from "../lib/release-manifest.js";
import { assertDatabaseAuthDirectory, renderStackCompose } from "../lib/stack-compose.js";
import { gatewayAdmissionProfile, renderGatewayConfig } from "../lib/gateway-config.js";
import { renderKeeperConfig } from "../lib/keeper-config.js";
import { renderKeeperComposeEnvironment } from "./render-keeper-config.js";
import { assertSafeAuthorityAncestors, readProtectedInstallationSettings, resolveGatewayAuthority, recheckGatewayAuthoritySources } from "../lib/gateway-authority.js";
import { gatewayCanonical } from "@lares/agent-kit/gateway-admission-protocol";
import { rejectDuplicateJsonKeys } from "../../keeper/lib/budget-native-client.js";
import type { KeeperConfig } from "../../keeper/lib/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
export const GATEWAY_AUTHORITY_STAGE_FILES = [
  "Caddyfile",
  "compose.lares-keeper.yaml",
  "compose.yaml",
  "gateway-start.sh",
  "gateway-start.sh.admission_contract.py",
  "gateway-start.sh.lares_gateway.py",
  "keeper.env",
  "keeper.json",
  "litellm-config.yaml",
  "litellm-config.yaml.profile.json",
] as const;
const FILES = GATEWAY_AUTHORITY_STAGE_FILES;
const HASHES = ".complete.json";
const INCOMPLETE = ".incomplete.json";

export interface GatewayAuthorityStageRequest {
  readonly prefix: string;
  readonly releaseFile: string;
  readonly project: string;
  readonly network: string;
  readonly subnet: string;
  readonly proxyAddress: string;
  readonly pgDatabase: string;
}

/** Internal test seams; the CLI always uses the protected production defaults. */
export interface GatewayAuthorityStageTestSeams {
  readonly buildOutputs?: (request: GatewayAuthorityStageRequest) => StageBuild;
  readonly validateDestination?: (stageDir: string, prefix: string) => void;
  readonly acceptExistingDirectory?: (path: string) => boolean;
  readonly writeFile?: typeof writeExclusive;
}

export interface StageFile { readonly contents: Buffer; readonly mode: number }
export interface StageBuild {
  readonly files: Map<string, StageFile>;
  readonly sourceCommitment: string;
  readonly recheckSources: () => void;
}
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};
const asBuffer = (value: string) => Buffer.from(value, "utf8");

function strictRequest(text: string): GatewayAuthorityStageRequest {
  rejectDuplicateJsonKeys(text);
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stage request is invalid");
  const record = value as Record<string, unknown>;
  const names = ["prefix", "releaseFile", "project", "network", "subnet", "proxyAddress", "pgDatabase"];
  if (Object.keys(record).sort().join(",") !== names.sort().join(",") || names.some(name => typeof record[name] !== "string" || !record[name]))
    throw new Error("stage request is incomplete");
  const request = record as unknown as GatewayAuthorityStageRequest;
  if (!isAbsolute(request.prefix) || normalize(request.prefix) !== request.prefix || !isAbsolute(request.releaseFile) ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(request.project)) throw new Error("stage request paths or project are invalid");
  return request;
}

function optionalPlainFile(path: string): string | null {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() ? path : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readExistingRenderedOutput(path: string): string {
  assertSafeAuthorityAncestors(path);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    const valid = (info: ReturnType<typeof fstatSync>) => info.isFile() && info.uid === 0 && info.nlink === 1 &&
      (Number(info.mode) & 0o022) === 0 && info.size <= 1_048_576;
    if (!valid(before)) throw new Error();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd), visible = lstatSync(path);
    if (length !== before.size || !valid(after) || !valid(visible) || visible.isSymbolicLink() ||
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.dev !== visible.dev || before.ino !== visible.ino || before.size !== visible.size || before.mtimeMs !== visible.mtimeMs)
      throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } catch {
    throw new Error("existing rendered authority output is unavailable or unsafe");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function parseStageEnvironment(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("existing Keeper environment is ambiguous");
    const name = line.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || Object.hasOwn(values, name)) throw new Error("existing Keeper environment is ambiguous");
    const value = line.slice(separator + 1);
    // The renderer writes plain, unquoted, whitespace-free assignments. Reject dotenv
    // quoting, comments, escapes and interpolation instead of trying to emulate its parser.
    if (!value || /[\s"'#$\\]/u.test(value)) throw new Error("existing Keeper environment is noncanonical");
    values[name] = value;
  }
  return values;
}

function environmentObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("existing Gateway compose is ambiguous");
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error("existing Gateway compose is ambiguous");
    result[key] = entry;
  }
  return result;
}

function resolveComposeInterpolation(value: string, env: Record<string, string>): string {
  // Resolve the exact interpolation forms used by the committed Compose templates before
  // parsing short volume syntax: `${ROOT:?…}:${ROOT:?…}` contains expression colons.
  const sentinel = "\u0000COMPOSE_DOLLAR\u0000";
  let result = value.replaceAll("$$", sentinel);
  result = result.replace(/\$\{([A-Z][A-Z0-9_]*)(?:(:-|:\?)([^}]*))?\}/g, (_whole, name: string, operator: string | undefined, argument: string | undefined) => {
    const current = env[name];
    const isSet = current !== undefined;
    const isNonEmpty = isSet && current !== "";
    if (operator === ":-") return isNonEmpty ? current! : argument ?? "";
    if (operator === ":?") {
      if (!isNonEmpty) throw new Error("existing compose required variable is unresolved");
      return current!;
    }
    if (!isSet) throw new Error("existing compose variable is unresolved");
    return current!;
  });
  if (result.includes("$") || result.includes("}")) throw new Error("existing compose interpolation is unsupported or unresolved");
  return result.replaceAll(sentinel, "$");
}

function resolvedComposeMount(value: unknown, envValues: Record<string, string>, base: string): { source?: string; target?: string; ro: boolean; bind: boolean; noCreate: boolean } {
  const sourcePath = (source: string) => {
    const absolute = source.startsWith("/") ? normalize(source) : normalize(join(base, source));
    try { return realpathSync(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute; throw error; }
  };
  if (typeof value === "string") {
    const expanded = resolveComposeInterpolation(value, envValues);
    const parts = expanded.split(":");
    if (parts.length < 2 || parts.length > 3 || !parts[1]!.startsWith("/")) throw new Error("existing compose mount is ambiguous");
    const source = parts[0]!, target = parts[1]!, options = parts.slice(2).join(":").split(",");
    const bind = source.startsWith("/") || source.startsWith("./") || source.startsWith("../");
    if (!bind) throw new Error("existing compose named-volume mount cannot be proven isolated");
    return { ...(bind ? { source: sourcePath(source) } : {}), target: normalize(target), ro: options.includes("ro"), bind, noCreate: false };
  }
  if (!value || typeof value !== "object") throw new Error("existing compose mount is ambiguous");
  const record = value as Record<string, any>;
  if (record.type === "volume") throw new Error("existing compose named-volume mount cannot be proven isolated");
  const sourceRaw = typeof record.source === "string" ? resolveComposeInterpolation(record.source, envValues) : undefined;
  const targetRaw = typeof record.target === "string" ? resolveComposeInterpolation(record.target, envValues) : undefined;
  if (!targetRaw?.startsWith("/") || !["bind", "volume", "tmpfs"].includes(record.type)) throw new Error("existing compose mount is ambiguous");
  const source = record.type === "bind" && sourceRaw ? sourcePath(sourceRaw) : undefined;
  return { source, target: normalize(targetRaw), ro: record.read_only === true, bind: record.type === "bind", noCreate: record.bind?.create_host_path === false };
}

export function assertExistingRenderedAuthorityText(existing: {
  readonly profile: string; readonly stack: string; readonly keeperCompose: string; readonly keeperEnv: string;
}, authority: {
  readonly origin: string; readonly endpointHash: string; readonly serviceKeyFile: string;
  readonly policyFile: string; readonly profile: unknown;
}): void {
  const etc = dirname(dirname(authority.serviceKeyFile));
  const opt = join(dirname(dirname(etc)), "opt", "lares");
  const activeProfileText = existing.profile;
  rejectDuplicateJsonKeys(activeProfileText);
  let activeProfile: unknown;
  try { activeProfile = JSON.parse(activeProfileText); }
  catch { throw new Error("existing Gateway profile is invalid"); }
  if (!gatewayCanonical(activeProfile).equals(gatewayCanonical(authority.profile)))
    throw new Error("existing rendered Gateway profile differs from reviewed authority");

  const stack = parseYaml(existing.stack) as Record<string, any>;
  const gateway = stack.services?.["lares-gateway"];
  if (!gateway || !Array.isArray(gateway.volumes)) throw new Error("existing Gateway compose is ambiguous");
  const env = environmentObject(gateway.environment);
  const composeEnv = { ...parseStageEnvironment(existing.keeperEnv), ...process.env } as Record<string, string>;
  const profilePath = join(etc, "litellm-config.yaml.profile.json");
  const authorityKeys = ["LARES_GATEWAY_ADMISSION_URL", "LARES_GATEWAY_ENDPOINT_HASH", "LARES_GATEWAY_SERVICE_KEY_FILE"];
  const configured = authorityKeys.filter(key => Object.hasOwn(env, key)).length;
  const keyPath = normalize(authority.serviceKeyFile);
  const policyPath = normalize(authority.policyFile);
  const gatewayKeyTarget = "/run/secrets/gateway-budget-service-key";
  const pathCovers = (mountPath: string, filePath: string) => mountPath === filePath || mountPath === "/" ||
    filePath.startsWith(`${mountPath.replace(/\/$/, "")}/`);
  const profileTarget = "/etc/litellm/profile.json";
  const profileMounts = gateway.volumes.filter((mount: unknown) => {
    const parsed = resolvedComposeMount(mount, composeEnv, opt);
    return (!!parsed.source && pathCovers(parsed.source, profilePath)) || (!!parsed.target && pathCovers(parsed.target, profileTarget));
  });
  const expectedProfileSource = resolvedComposeMount(`${profilePath}:${profileTarget}:ro`, composeEnv, opt).source;
  if (profileMounts.length !== 1 || !profileMounts.some((mount: unknown) => {
    const parsed = resolvedComposeMount(mount, composeEnv, opt);
    return parsed.source === expectedProfileSource && parsed.target === profileTarget && parsed.ro;
  })) throw new Error("existing Gateway does not mount the reviewed profile read-only");
  const gatewayKeyMounts = gateway.volumes.filter((mount: unknown) => {
    const parsed = resolvedComposeMount(mount, composeEnv, opt);
    return (!!parsed.source && pathCovers(parsed.source, keyPath)) || (!!parsed.target && pathCovers(parsed.target, gatewayKeyTarget));
  });
  let gatewayBound = false;
  if (configured === 0 && gatewayKeyMounts.length === 0) gatewayBound = false;
  else {
    if (configured !== authorityKeys.length) throw new Error("existing Gateway authority is only partly bound");
    if (env.LARES_GATEWAY_ADMISSION_URL !== authority.origin || env.LARES_GATEWAY_ENDPOINT_HASH !== authority.endpointHash ||
        env.LARES_GATEWAY_SERVICE_KEY_FILE !== "/run/secrets/gateway-budget-service-key")
      throw new Error("existing Gateway authority differs from the reviewed binding");
    const exactKeyMount = gatewayKeyMounts.length === 1 && gateway.volumes.some((mount: unknown) => {
      const parsed = resolvedComposeMount(mount, composeEnv, opt);
      return parsed.source === keyPath && parsed.target === gatewayKeyTarget && parsed.bind && parsed.ro && parsed.noCreate;
    });
    if (!exactKeyMount) throw new Error("existing Gateway service-key mount differs from the reviewed binding");
    gatewayBound = true;
  }

  const keeperCompose = parseYaml(existing.keeperCompose) as Record<string, any>;
  const rejectComposeImportsAndVolumeInheritance = (document: Record<string, any>) => {
    if (Object.hasOwn(document, "include") || Object.hasOwn(document, "extends"))
      throw new Error("existing compose include or top-level extends is unsupported");
    const services = document.services;
    if (!services || typeof services !== "object" || Array.isArray(services)) throw new Error("existing compose services are ambiguous");
    for (const service of Object.values(services)) {
      if (!service || typeof service !== "object" || Array.isArray(service)) continue;
      if (Object.hasOwn(service, "extends")) throw new Error("existing compose service extends is unsupported");
      if (Object.hasOwn(service, "volumes_from")) throw new Error("existing compose service volumes_from is unsupported");
    }
  };
  rejectComposeImportsAndVolumeInheritance(stack);
  rejectComposeImportsAndVolumeInheritance(keeperCompose);
  const keeper = keeperCompose.services?.["lares-keeper"];
  if (!keeper || !Array.isArray(keeper.volumes)) throw new Error("existing Keeper compose is ambiguous");
  const keeperEnv = parseStageEnvironment(existing.keeperEnv);
  const keeperComposeEnv = { ...keeperEnv, ...process.env } as Record<string, string>;
  const keeperKeys = ["LARES_GATEWAY_BUDGET_SERVICE_KEY_FILE", "LARES_NATIVE_POLICY_FILE", "LARES_GATEWAY_BUDGET_SERVICE_KEY_TARGET", "LARES_NATIVE_POLICY_TARGET"];
  const keeperConfigured = keeperKeys.filter(key => Object.hasOwn(keeperEnv, key)).length;
  const defaults: Record<string, string> = {
    LARES_GATEWAY_BUDGET_SERVICE_KEY_FILE: "/dev/null",
    LARES_NATIVE_POLICY_FILE: "/dev/null",
    LARES_GATEWAY_BUDGET_SERVICE_KEY_TARGET: "/run/secrets/gateway-budget-unused-key",
    LARES_NATIVE_POLICY_TARGET: "/etc/lares/native-policy-unused.json",
  };
  const resolved = keeperKeys.map(key => keeperEnv[key] ?? defaults[key]!);
  const [keySource, policySource, keyTarget, policyTarget] = resolved;
  const isDefault = resolved.every((value, index) => value === defaults[keeperKeys[index]!]);
  const keeperAuthorityMounts = keeper.volumes.filter((mount: unknown) => {
    const parsed = resolvedComposeMount(mount, keeperComposeEnv, opt);
    return (!!parsed.source && (pathCovers(parsed.source, keyPath) || pathCovers(parsed.source, policyPath))) ||
      (!!parsed.target && (pathCovers(parsed.target, keyPath) || pathCovers(parsed.target, policyPath)));
  });
  const keeperBound = !isDefault;
  if (keeperConfigured !== 0 && keeperConfigured !== keeperKeys.length || isDefault && keeperAuthorityMounts.length > 0)
    throw new Error("existing Keeper authority is only partly bound");
  if (keeperBound && (keySource !== authority.serviceKeyFile || policySource !== authority.policyFile ||
      keyTarget !== authority.serviceKeyFile || policyTarget !== authority.policyFile))
    throw new Error("existing Keeper authority differs from the reviewed binding");
  if (keeperBound && keeperAuthorityMounts.length !== 2) throw new Error("existing Keeper authority mounts are missing or duplicated");
  if (gatewayBound !== keeperBound) throw new Error("existing Gateway and Keeper authority state is ambiguous");
  if (keeperBound) {
    const exactMount = (source: string, target: string) => keeperAuthorityMounts.filter((mount: unknown) => {
      const parsed = resolvedComposeMount(mount, keeperComposeEnv, opt);
      return parsed.bind && parsed.ro && parsed.noCreate && parsed.source === normalize(source) && parsed.target === normalize(target);
    }).length === 1;
    if (!exactMount(authority.serviceKeyFile, authority.serviceKeyFile) || !exactMount(authority.policyFile, authority.policyFile))
      throw new Error("existing Keeper read-only authority mounts differ from the reviewed binding");
  }

  const validateServices = (services: Record<string, any>, sourceEnv: Record<string, string>) => {
    for (const [serviceName, service] of Object.entries(services)) {
      if (service?.volumes !== undefined && !Array.isArray(service.volumes)) throw new Error("existing compose service mounts are ambiguous");
      for (const item of service?.volumes ?? []) {
        const parsed = resolvedComposeMount(item, sourceEnv, opt);
        const covers = (path: string | undefined, target: string) => !!path && pathCovers(path, target);
        const sourceKey = covers(parsed.source, keyPath), sourcePolicy = covers(parsed.source, policyPath);
        const targetKey = covers(parsed.target, gatewayKeyTarget) || covers(parsed.target, keyPath);
        const targetPolicy = covers(parsed.target, policyPath) || covers(parsed.target, "/etc/lares/native-policy.json");
        const sourceProfile = covers(parsed.source, profilePath), targetProfile = covers(parsed.target, profileTarget);
        if (!sourceKey && !sourcePolicy && !targetKey && !targetPolicy && !sourceProfile && !targetProfile) continue;
        const exactGateway = serviceName === "lares-gateway" && parsed.source === keyPath && parsed.target === gatewayKeyTarget && parsed.bind && parsed.ro && parsed.noCreate;
        const exactProfile = serviceName === "lares-gateway" && parsed.source === expectedProfileSource && parsed.target === profileTarget && parsed.ro;
        const exactKeeperKey = serviceName === "lares-keeper" && parsed.source === keyPath && parsed.target === keyPath && parsed.bind && parsed.ro && parsed.noCreate;
        const exactKeeperPolicy = serviceName === "lares-keeper" && parsed.source === policyPath && parsed.target === policyPath && parsed.bind && parsed.ro && parsed.noCreate;
        if (!(exactGateway || exactProfile || exactKeeperKey || exactKeeperPolicy)) throw new Error("existing compose exposes or masks authority through a non-exact mount");
      }
    }
  };
  const validateComposeFileMounts = (document: Record<string, any>, services: Record<string, any>, kind: "secrets" | "configs") => {
    const definitions = document[kind] ?? {};
    if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) throw new Error(`existing compose ${kind} are ambiguous`);
    for (const definition of Object.values(definitions)) {
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error(`existing compose ${kind} are ambiguous`);
      const file = (definition as Record<string, unknown>).file;
      if (typeof file === "string") {
        if (file.includes("$")) throw new Error(`existing compose ${kind} source is ambiguous`);
        const source = resolvedComposeMount({ type: "bind", source: file, target: "/run/secrets/probe", read_only: true, bind: { create_host_path: false } }, { ...parseStageEnvironment(existing.keeperEnv), ...process.env } as Record<string, string>, opt).source!;
        if (pathCovers(source, keyPath) || pathCovers(source, policyPath) || pathCovers(source, profilePath))
          throw new Error(`existing compose exposes authority through a file ${kind.slice(0, -1)}`);
      }
    }
    for (const [serviceName, service] of Object.entries(services)) {
      const grants = service?.[kind] ?? [];
      if (!Array.isArray(grants)) throw new Error(`existing compose service ${kind} are ambiguous`);
      for (const grant of grants) {
        const sourceName = typeof grant === "string" ? grant : grant && typeof grant === "object" ? (grant as Record<string, unknown>).source : undefined;
        const target = typeof grant === "string" ? undefined : grant && typeof grant === "object" ? (grant as Record<string, unknown>).target : undefined;
        if (typeof sourceName !== "string" || (target !== undefined && typeof target !== "string")) throw new Error(`existing compose service ${kind} are ambiguous`);
        if (typeof target === "string" && !target.startsWith("/")) throw new Error(`existing compose ${kind} target is ambiguous`);
        const targetPath = typeof target === "string" ? normalize(target) : kind === "secrets" ? `/run/secrets/${sourceName}` : `/${sourceName}`;
        if ([gatewayKeyTarget, keyPath, policyPath, profileTarget].some(expected => pathCovers(targetPath, expected)))
          throw new Error(`existing compose service ${serviceName} receives authority through a ${kind} mount`);
      }
    }
  };
  const rejectNamedVolumeDefinitions = (document: Record<string, any>) => {
    if (document.volumes !== undefined && (!document.volumes || typeof document.volumes !== "object" ||
        Array.isArray(document.volumes) || Object.keys(document.volumes).length > 0))
      throw new Error("existing compose named-volume definitions cannot be proven isolated");
  };
  const stackServices = stack.services as Record<string, any>, keeperServices = keeperCompose.services as Record<string, any>;
  validateServices(stackServices, composeEnv);
  validateServices(keeperServices, keeperComposeEnv);
  rejectNamedVolumeDefinitions(stack);
  rejectNamedVolumeDefinitions(keeperCompose);
  validateComposeFileMounts(stack, stackServices, "secrets");
  validateComposeFileMounts(keeperCompose, keeperServices, "secrets");
  validateComposeFileMounts(stack, stackServices, "configs");
  validateComposeFileMounts(keeperCompose, keeperServices, "configs");
}

function assertExistingRenderedAuthority(prefix: string, authority: Parameters<typeof assertExistingRenderedAuthorityText>[1]): void {
  const etc = join(prefix, "etc", "lares"), opt = join(prefix, "opt", "lares");
  assertExistingRenderedAuthorityText({
    profile: readExistingRenderedOutput(join(etc, "litellm-config.yaml.profile.json")),
    stack: readExistingRenderedOutput(join(opt, "compose.yaml")),
    keeperCompose: readExistingRenderedOutput(join(opt, "compose.lares-keeper.yaml")),
    keeperEnv: readExistingRenderedOutput(join(etc, "keeper.env")),
  }, authority);
}

function stageOutput(request: GatewayAuthorityStageRequest): StageBuild {
  const prefix = request.prefix;
  const databaseAuthDir = join(prefix, "var", "lib", "lares-maintenance", "postgres-auth");
  // This boundary only validates already established external custody. Staging must never
  // create, adopt, or rewrite normal authentication state.
  assertDatabaseAuthDirectory(databaseAuthDir, prefix, request.subnet);
  const etc = join(prefix, "etc", "lares");
  const secretsDir = join(etc, "secrets");
  const keeperConfigFile = join(etc, "keeper.json");
  const installationEnvFile = join(etc, "installation.env");
  const consoleOauthEnvFile = join(etc, "console-oauth.env");
  const gatewayConfigFile = join(etc, "litellm-config.yaml");
  const gatewayStartScript = join(etc, "gateway-start.sh");
  const gateway = {
    alias: "",
    providerModel: "",
  };

  // Resolve first from protected files, including the real reviewed policy and the fixed key
  // inode. Values returned here are configuration paths/identity only; key bytes are discarded.
  const settings = readProtectedInstallationSettings(installationEnvFile);
  gateway.alias = settings.LARES_MODEL_ALIAS!;
  gateway.providerModel = settings.LARES_MODEL!;
  const authority = resolveGatewayAuthority({
    installationEnvFile,
    consoleOauthEnvFile,
    keeperConfigFile,
    secretsDir,
    gateway,
    expectedServiceKeyFile: join(secretsDir, "gateway-budget-service-key"),
  });

  const manifest = parseReleaseManifest(readFileSync(request.releaseFile, "utf8"));
  const root = join(prefix, "srv", "lares");
  const agentsDir = join(root, "agents");
  const retiredDir = join(root, "retired");
  const backupDir = join(root, "backup");
  const egressDir = join(root, "egress");
  const socketDir = join(prefix, "run", "lares");
  const hostSocketDir = join(prefix, "run", "lares-host");
  const caddyfile = join(etc, "Caddyfile");
  const caddyDataDir = join(prefix, "var", "lib", "lares", "caddy");
  const dbDataDir = join(prefix, "var", "lib", "lares", "postgres");
  const tasteDir = join(prefix, "srv", "taste");
  const installationDir = join(root, "installation");
  const policy = authority.previousKeeperConfig as KeeperConfig;
  const runtime = policy.lifecycle?.runtime;
  const modelPurposeKey = optionalPlainFile(join(secretsDir, "console-model-purpose-signing-key"));
  const deadlineCalendarFile = optionalPlainFile(join(installationDir, "deadline-calendar.json"));
  const keeper = renderKeeperConfig(manifest, {
    ...(policy.budgetFinancial ? { previousBudgetFinancial: policy.budgetFinancial } : {}),
    ...(policy.budgetNative ? { previousBudgetNative: policy.budgetNative } : {}),
    ...(policy.gatewayBudget ? { previousGatewayBudget: policy.gatewayBudget } : {}),
    ...(typeof runtime?.schedulesLive === "boolean" ? { previousSchedulesLive: runtime.schedulesLive } : {}),
    modelPurposeConsoleSigningKeyFile: modelPurposeKey,
    modelPurposeRuntimeDir: modelPurposeKey ? join(socketDir, "model-purpose") : null,
    project: request.project,
    network: request.network,
    subnet: request.subnet,
    proxyAddress: request.proxyAddress,
    dir: root,
    agentsDir,
    retiredDir,
    backupDir,
    egressDir,
    secretsDir,
    pgDatabase: request.pgDatabase,
    gatewayUrl: authority.gatewayUrl,
    ownerId: authority.ownerId,
    credentialAdministrator: authority.ownerEmail,
    publicDoorOrigin: authority.origin,
    ...(authority.ownerHomeTz ? { ownerHomeTz: authority.ownerHomeTz } : {}),
    ...(deadlineCalendarFile ? { deadlineCalendarFile } : {}),
  });
  if (runtime?.google !== undefined) keeper.lifecycle!.runtime.google = runtime.google;
  if (runtime?.microsoft !== undefined) keeper.lifecycle!.runtime.microsoft = runtime.microsoft;
  const preserved = (next: unknown, previous: unknown) => next === undefined || previous === undefined ? next === previous :
    gatewayCanonical(next).equals(gatewayCanonical(previous));
  if (keeper.gatewayBudget?.serviceKeyFile !== authority.serviceKeyFile || keeper.budgetNative?.reviewedPolicyFile !== authority.policyFile ||
      !preserved(keeper.budgetFinancial, policy.budgetFinancial) || !preserved(keeper.budgetNative, policy.budgetNative) ||
      !preserved(keeper.gatewayBudget, policy.gatewayBudget))
    throw new Error("prepared Keeper custody bindings did not survive rendering unchanged");

  const profile = gatewayAdmissionProfile(gateway);
  const stack = renderStackCompose(manifest, {
    secretsDir,
    consoleVaultSigningKeyFile: optionalPlainFile(join(secretsDir, "console-vault-signing-key")),
    consoleModelPurposeSigningKeyFile: modelPurposeKey,
    socketDir,
    tasteDir,
    gatewayConfigFile,
    gatewayStartScript,
    caddyfile,
    caddyDataDir,
    dbDataDir,
    databaseAuthDir,
    network: request.network,
    subnet: request.subnet,
    domain: authority.domain,
    consoleAllowedEmails: authority.consoleAllowedEmails,
    ownerId: authority.ownerId,
    ownerHomeTz: authority.ownerHomeTz,
    modelAlias: authority.modelAlias,
    pgDatabase: request.pgDatabase,
    deadlineCalendarFile,
    gatewayAuthority: { origin: authority.origin, endpointHash: authority.endpointHash, serviceKeyFile: authority.serviceKeyFile },
  });
  const keeperEnv = renderKeeperComposeEnvironment(manifest, {
    root, keeperConfig: keeperConfigFile, socketDir, hostSocketDir, egressDir, secretsDir,
    proxyAddress: request.proxyAddress, network: request.network,
    gatewayAuthority: { serviceKeyFile: authority.serviceKeyFile, policyFile: authority.policyFile },
  }, keeper);
  assertExistingRenderedAuthority(prefix, {
    origin: authority.origin,
    endpointHash: authority.endpointHash,
    serviceKeyFile: authority.serviceKeyFile,
    policyFile: authority.policyFile,
    profile,
  });

  // Read every public template before the stage directory exists. These outputs mount the
  // eventual installation paths rendered above; nothing will point back into the stage dir.
  const contents = new Map<string, string>([
    ["Caddyfile", readFileSync(join(REPO, "services", "box", "ops", "Caddyfile"), "utf8")],
    ["compose.lares-keeper.yaml", readFileSync(join(REPO, "services", "box", "compose.lares-keeper.yaml"), "utf8")],
    ["compose.yaml", stack],
    ["gateway-start.sh", readFileSync(join(REPO, "images", "gateway-runtime", "start.sh"), "utf8")],
    ["gateway-start.sh.admission_contract.py", readFileSync(join(REPO, "images", "gateway-runtime", "admission_contract.py"), "utf8")],
    ["gateway-start.sh.lares_gateway.py", readFileSync(join(REPO, "images", "gateway-runtime", "lares_gateway.py"), "utf8")],
    ["keeper.env", keeperEnv],
    ["keeper.json", `${JSON.stringify(keeper, null, 2)}\n`],
    ["litellm-config.yaml", renderGatewayConfig(gateway)],
    ["litellm-config.yaml.profile.json", `${JSON.stringify(profile)}\n`],
  ]);
  const files = new Map<string, StageFile>();
  for (const name of FILES) {
    const mode = name === "keeper.json" ? 0o600 : name === "compose.yaml" || name === "keeper.env" ? 0o640 :
      name === "gateway-start.sh" ? 0o755 : 0o644;
    files.set(name, { contents: asBuffer(contents.get(name)!), mode });
  }
  const sourceCommitment = authority.sourceCommitment;
  const sourceInputs = { installationEnvFile, consoleOauthEnvFile, keeperConfigFile, secretsDir, gateway, expectedServiceKeyFile: join(secretsDir, "gateway-budget-service-key") };
  return { files, sourceCommitment, recheckSources: () => recheckGatewayAuthoritySources(sourceInputs, sourceCommitment) };
}

function marker(files: Map<string, StageFile>, sourceCommitment: string): Buffer {
  return asBuffer(`${JSON.stringify({ version: 2, sourceCommitment, hashes: FILES.map(name => sha256(files.get(name)!.contents)) })}\n`);
}

function safeStageDestination(stageDir: string, prefix: string): void {
  if (!isAbsolute(stageDir) || normalize(stageDir) !== stageDir || stageDir === parse(stageDir).root)
    throw new Error("stage destination must be a new absolute directory");
  const protectedTrees = [join(prefix, "etc", "lares"), join(prefix, "opt", "lares"), join(prefix, "srv", "lares"), join(prefix, "var", "lib", "lares")];
  if (protectedTrees.some(tree => inside(tree, stageDir))) throw new Error("stage destination is inside an active installation tree");
  let parent = dirname(stageDir);
  for (;;) {
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0))
      throw new Error("stage parent is unavailable or unsafe");
    const next = dirname(parent);
    if (next === parent || parent === parse(parent).root) break;
    parent = next;
  }
}

function verifyExistingStage(stageDir: string, files: Map<string, StageFile>, sourceCommitment: string): boolean {
  const expectedNames = [...FILES, HASHES].sort();
  const actualNames = readdirSync(stageDir).sort();
  if (!actualNames.length) return false;
  if (actualNames.join("\0") !== expectedNames.join("\0")) throw new Error("existing stage is incomplete or contains unknown files");
  const expectedMarker = marker(files, sourceCommitment);
  const markerPath = join(stageDir, HASHES);
  const markerStat = lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o777) !== 0o600 ||
      !readFileSync(markerPath).equals(expectedMarker)) throw new Error("existing stage does not match current validated inputs");
  for (const name of FILES) {
    const path = join(stageDir, name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== files.get(name)!.mode ||
        !readFileSync(path).equals(files.get(name)!.contents)) throw new Error("existing stage is incomplete or changed");
  }
  return true;
}

function writeExclusive(path: string, data: Buffer, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    fchmodSync(fd, mode);
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function stageGatewayAuthority(stageDir: string, request: GatewayAuthorityStageRequest, seams: GatewayAuthorityStageTestSeams = {}): "written" | "unchanged" {
  strictRequest(JSON.stringify(request));
  const build = (seams.buildOutputs ?? stageOutput)(request);
  const { files, sourceCommitment, recheckSources } = build;
  (seams.validateDestination ?? safeStageDestination)(stageDir, request.prefix);
  if (existsSync(stageDir)) {
    const info = lstatSync(stageDir);
    const trusted = seams.acceptExistingDirectory ? seams.acceptExistingDirectory(stageDir) :
      info.uid === 0 && info.gid === 0 && (info.mode & 0o777) === 0o700;
    if (!info.isDirectory() || info.isSymbolicLink() || !trusted)
      throw new Error("existing stage destination is unavailable or unsafe");
    recheckSources();
    if (verifyExistingStage(stageDir, files, sourceCommitment)) return "unchanged";
    throw new Error("existing stage is incomplete or contains unknown files");
  }
  return writeStage(stageDir, files, sourceCommitment, recheckSources, seams.writeFile);
}

function writeStage(stageDir: string, files: Map<string, StageFile>, sourceCommitment: string, recheckSources: () => void,
  write: typeof writeExclusive = writeExclusive): "written" {
  mkdirSync(stageDir, { mode: 0o700 });
  const incomplete = asBuffer(`${JSON.stringify({ version: 2, sourceCommitment, hashes: FILES.map(name => sha256(files.get(name)!.contents)) })}\n`);
  const markerPath = join(stageDir, HASHES);
  try {
    write(join(stageDir, INCOMPLETE), incomplete, 0o600);
    for (const name of FILES) write(join(stageDir, name), files.get(name)!.contents, files.get(name)!.mode);
    recheckSources();
    unlinkSync(join(stageDir, INCOMPLETE));
    const dir = openSync(stageDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); }
    finally { closeSync(dir); }
    recheckSources();
    write(markerPath, marker(files, sourceCommitment), 0o600);
    recheckSources();
    const completeDir = openSync(stageDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(completeDir); }
    finally { closeSync(completeDir); }
  } catch (error) {
    try { unlinkSync(markerPath); } catch {}
    try { if (!existsSync(join(stageDir, INCOMPLETE))) write(join(stageDir, INCOMPLETE), incomplete, 0o600); } catch {}
    throw error;
  }
  return "written";
}

export function main(argv: readonly string[], out: (value: string) => void): number {
  if (argv.length !== 1 || argv[0] === "--help" || argv[0] === "-h") {
    out("Usage: render-gateway-authority-stage <new-stage-directory>\nRead a non-secret JSON request from stdin with prefix, releaseFile, project, network, subnet, proxyAddress and pgDatabase.");
    return argv.length === 1 ? 0 : 1;
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) throw new Error("run the staged authority renderer as root");
  const request = strictRequest(readFileSync(0, "utf8"));
  const result = stageGatewayAuthority(argv[0]!, request);
  out(result === "unchanged" ? "Validated staged gateway authority is already complete." : "Staged gateway authority is complete; no services were started.");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2), value => process.stdout.write(`${value}\n`)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "gateway authority staging failed"}\n`);
    process.exitCode = 1;
  }
}
