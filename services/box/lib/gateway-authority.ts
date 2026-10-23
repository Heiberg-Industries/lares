import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { providerIdentitySchema } from "@lares/agent-kit/authority-contract";
import { gatewayCanonical } from "@lares/agent-kit/gateway-admission-protocol";
import { rejectDuplicateJsonKeys } from "../../keeper/lib/budget-native-client.js";
import { readBudgetNativePolicyDocument } from "../../keeper/lib/budget-native-host.js";
import { financialCustodyConfigSchema, gatewayBudgetConfigSchema, nativeCustodyConfigSchema } from "../../keeper/lib/config.js";
import { gatewayAdmissionProfile, type GatewayConfigOptions } from "./gateway-config.js";

const BOOTSTRAP_KEY = "CONSOLE_BOOTSTRAP_IDENTITY";
const SERVICE_KEY_NAME = "gateway-budget-service-key";
const HASH = /^[a-f0-9]{64}$/;

function pythonCompactJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("bootstrap selection is invalid");
  return encoded;
}

export interface GatewayAuthoritySources {
  readonly installationEnvFile: string;
  readonly consoleOauthEnvFile: string;
  readonly keeperConfigFile: string;
  readonly secretsDir: string;
  readonly gateway: GatewayConfigOptions;
  readonly expectedServiceKeyFile: string;
}

export interface ResolvedGatewayAuthority {
  readonly origin: string;
  readonly endpointHash: string;
  readonly serviceKeyFile: string;
  readonly policyFile: string;
  readonly ownerId: string;
  readonly domain: string;
  readonly modelAlias: string;
  readonly providerModel: string;
  readonly consoleAllowedEmails: string;
  readonly ownerEmail: string;
  readonly ownerHomeTz: string;
  readonly gatewayUrl: string;
  readonly previousKeeperConfig: Readonly<Record<string, unknown>>;
  /** Hash commitment to the exact protected inputs used for this render; never contains key bytes. */
  readonly sourceCommitment: string;
}

type FileMetadata = ReturnType<typeof fstatSync>;
export type GatewayServiceKeyMetadata = Pick<FileMetadata, "uid" | "gid" | "nlink" | "mode" | "size"> & { isFile(): boolean };

export function gatewayServiceKeyMetadataIsSafe(info: GatewayServiceKeyMetadata): boolean {
  return info.isFile() && info.uid === 0 && info.gid === 0 && info.nlink === 1 &&
    (Number(info.mode) & 0o7777) === 0o600 && info.size === 32;
}

interface ProtectedFileSnapshot { readonly bytes: Buffer; readonly identity: string }

function protectedFileSnapshot(path: string, mode: number, ownerGid?: number): ProtectedFileSnapshot {
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    const valid = (info: FileMetadata) => info.isFile() && info.nlink === 1 && info.uid === 0 &&
      (ownerGid === undefined || info.gid === ownerGid) && (Number(info.mode) & 0o777) === mode && (Number(info.mode) & 0o022) === 0;
    if (!valid(before) || before.size > 65_536) throw new Error("protected source is unavailable");
    bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    const visible = lstatSync(path);
    if (length !== before.size || !valid(after) || !valid(visible) || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.dev !== visible.dev || before.ino !== visible.ino ||
        before.size !== visible.size || before.mtimeMs !== visible.mtimeMs || before.ctimeMs !== visible.ctimeMs) throw new Error("protected source changed while read");
    const result = Buffer.from(bytes.subarray(0, length));
    const identity = [before.dev, before.ino, before.uid, before.gid, before.nlink, Number(before.mode) & 0o7777,
      before.size, before.mtimeMs, before.ctimeMs].join(":");
    return { bytes: result, identity };
  } catch {
    throw new Error("gateway authority source is unavailable or unsafe");
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

function protectedFile(path: string, mode: number, ownerGid?: number): Buffer {
  return protectedFileSnapshot(path, mode, ownerGid).bytes;
}

function safeAncestors(file: string): void {
  let current = dirname(file);
  for (;;) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o022) !== 0)
      throw new Error("gateway service-key custody path is unsafe");
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
}

export function assertSafeAuthorityAncestors(file: string): void {
  safeAncestors(file);
}

function readStrictJson(path: string, mode: number): Record<string, unknown> {
  safeAncestors(path);
  const bytes = protectedFile(path, mode, 0);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rejectDuplicateJsonKeys(text);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("gateway authority source is unavailable or invalid");
  } finally {
    bytes.fill(0);
  }
}

function decodeShellValue(raw: string): string {
  if (!raw.startsWith("'")) {
    if (!/^[A-Za-z0-9@._:/=-]*$/.test(raw)) throw new Error("installation setting is malformed");
    return raw;
  }
  let index = 1;
  let value = "";
  while (index < raw.length) {
    const end = raw.indexOf("'", index);
    if (end < 0) throw new Error("installation setting is malformed");
    value += raw.slice(index, end);
    index = end + 1;
    if (index === raw.length) break;
    if (raw.slice(index, index + 3) !== "\\''") throw new Error("installation setting is malformed");
    value += "'";
    index += 3;
  }
  return value;
}

export function parseInstallationSettings(text: string): Record<string, string> {
  try {
    const wanted = new Set(["LARES_OWNER_ID", "LARES_OWNER_EMAIL", "LARES_DOMAIN", "LARES_MODEL_ALIAS", "LARES_MODEL", "CONSOLE_ALLOWED_EMAILS", "OWNER_HOME_TZ", "GATEWAY_URL"]);
    const values: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const candidate = line.trimStart();
      if (!candidate || candidate.startsWith("#")) continue;
      const selected = [...wanted].find(name => new RegExp(`^${name}(?=\\s|=|$)`).test(candidate));
      if (!selected) continue;
      if (candidate !== line) throw new Error("installation setting is malformed");
      const at = line.indexOf("=");
      if (at < 1 || line.slice(0, at) !== selected) throw new Error("installation setting is malformed");
      const key = selected;
      if (Object.hasOwn(values, key)) throw new Error("installation settings are duplicated");
      const raw = line.slice(at + 1);
      if (!raw) throw new Error("installation setting is malformed");
      values[key] = decodeShellValue(raw);
    }
    for (const key of ["LARES_OWNER_ID", "LARES_OWNER_EMAIL", "LARES_DOMAIN", "LARES_MODEL_ALIAS", "LARES_MODEL", "CONSOLE_ALLOWED_EMAILS", "GATEWAY_URL"])
      if (!values[key]?.trim()) throw new Error("installation settings are incomplete");
    if (!/^[a-z0-9.-]+$/.test(values.LARES_DOMAIN!) || !values.LARES_DOMAIN!.includes(".")) throw new Error("installation domain is invalid");
    return values;
  } catch {
    throw new Error("installation settings are unavailable or invalid");
  }
}

export function readProtectedInstallationSettings(path: string): Record<string, string> {
  safeAncestors(path);
  const bytes = protectedFile(path, 0o640);
  try { return parseInstallationSettings(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("installation settings are unavailable or invalid"); }
  finally { bytes.fill(0); }
}

function decodeComposeDollars(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "$") { result += value[index]; continue; }
    if (value[index + 1] !== "$") throw new Error("bootstrap selection encoding is invalid");
    result += "$";
    index++;
  }
  return result;
}

export function parseConfirmedBootstrapSelection(text: string): { ownerId: string; organisationId: string; installationOrigin: string } {
  try {
    const found: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.trimStart().startsWith("#")) continue;
      if (line.startsWith(`${BOOTSTRAP_KEY}=`)) found.push(line.slice(BOOTSTRAP_KEY.length + 1));
      else if (line.trimStart().startsWith(BOOTSTRAP_KEY)) throw new Error("bootstrap selection is ambiguous");
    }
    if (found.length !== 1) throw new Error("bootstrap selection is missing or duplicated");
    const selectionText = decodeComposeDollars(found[0]!);
    rejectDuplicateJsonKeys(selectionText);
    const selection: unknown = JSON.parse(selectionText);
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error();
    const value = selection as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "digest,identity,installationOrigin,organisationId,ownerId" ||
        typeof value.ownerId !== "string" || !value.ownerId.trim() || typeof value.organisationId !== "string" ||
        typeof value.installationOrigin !== "string" || !HASH.test(String(value.digest))) throw new Error();
    const identity = providerIdentitySchema.parse(value.identity);
    const normalizedIdentity = { issuer: identity.issuer, subject: identity.subject, ...(identity.tenantId === undefined ? {} : { tenantId: identity.tenantId }) };
    const origin = value.installationOrigin;
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error();
    const expected = createHash("sha256").update(pythonCompactJson({
      purpose: "lares-owner-bootstrap-v1", ownerId: value.ownerId, organisationId: value.organisationId,
      installationOrigin: origin, identity: normalizedIdentity,
    })).digest();
    const actual = Buffer.from(String(value.digest), "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    return { ownerId: value.ownerId, organisationId: value.organisationId, installationOrigin: origin };
  } catch {
    throw new Error("confirmed bootstrap selection is unavailable or invalid");
  }
}

function readBootstrapSelection(path: string): { ownerId: string; organisationId: string; installationOrigin: string } {
  safeAncestors(path);
  const bytes = protectedFile(path, 0o600, 0);
  try { return parseConfirmedBootstrapSelection(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("confirmed bootstrap selection is unavailable or invalid"); }
  finally { bytes.fill(0); }
}

function validateServiceKey(path: string, secretsDir: string): void {
  const expected = join(secretsDir, SERVICE_KEY_NAME);
  if (!isAbsolute(path) || normalize(path) !== path || path !== expected) throw new Error("gateway service-key path is not the fixed protected file");
  safeAncestors(path);
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    const valid = (info: GatewayServiceKeyMetadata) => gatewayServiceKeyMetadataIsSafe(info);
    if (!valid(before)) throw new Error();
    bytes = Buffer.alloc(33);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd), visible = lstatSync(path);
    if (length !== 32 || !valid(after) || !valid(visible) || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.dev !== visible.dev || before.ino !== visible.ino ||
        before.size !== visible.size || before.mtimeMs !== visible.mtimeMs || before.ctimeMs !== visible.ctimeMs) throw new Error();
  } catch {
    throw new Error("gateway service-key custody is unavailable or unsafe");
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

function captureSourceCommitment(sources: GatewayAuthoritySources): string {
  const items: Array<[string, string, ProtectedFileSnapshot]> = [];
  try {
    for (const [name, path, mode, gid] of [
      ["installation", sources.installationEnvFile, 0o640, undefined],
      ["bootstrap", sources.consoleOauthEnvFile, 0o600, 0],
      ["keeper", sources.keeperConfigFile, 0o600, 0],
    ] as const) {
      safeAncestors(path);
      items.push([name, normalize(path), protectedFileSnapshot(path, mode, gid)]);
    }
    const keeperText = new TextDecoder("utf-8", { fatal: true }).decode(items[2]![2].bytes);
    rejectDuplicateJsonKeys(keeperText);
    const keeper = JSON.parse(keeperText) as Record<string, unknown>;
    const native = nativeCustodyConfigSchema.parse(keeper.budgetNative);
    if (!native.reviewedPolicyFile) throw new Error();
    safeAncestors(native.reviewedPolicyFile);
    items.push(["policy", normalize(native.reviewedPolicyFile), protectedFileSnapshot(native.reviewedPolicyFile, 0o600, 0)]);
    const keyPath = join(sources.secretsDir, SERVICE_KEY_NAME);
    validateServiceKey(keyPath, sources.secretsDir);
    safeAncestors(keyPath);
    // Hash the key in memory only. The protected completion marker stores one aggregate
    // commitment, not key bytes or a separately exposed key digest.
    const keySnapshot = protectedFileSnapshot(keyPath, 0o600, 0);
    if (keySnapshot.bytes.length !== 32) { keySnapshot.bytes.fill(0); throw new Error(); }
    items.push(["key", normalize(keyPath), keySnapshot]);
    const digest = createHash("sha256");
    for (const [name, path, snapshot] of items) {
      digest.update(name).update("\0").update(path).update("\0").update(snapshot.identity).update("\0")
        .update(createHash("sha256").update(snapshot.bytes).digest()).update("\0");
    }
    return digest.digest("hex");
  } catch {
    throw new Error("gateway authority source is unavailable or unsafe");
  } finally {
    for (const [, , snapshot] of items) snapshot.bytes.fill(0);
  }
}

export function resolveGatewayAuthority(sources: GatewayAuthoritySources): ResolvedGatewayAuthority {
  const sourceCommitment = captureSourceCommitment(sources);
  const installation = readProtectedInstallationSettings(sources.installationEnvFile);
  const keeper = readStrictJson(sources.keeperConfigFile, 0o600);
  const selection = readBootstrapSelection(sources.consoleOauthEnvFile);
  const financial = financialCustodyConfigSchema.safeParse(keeper.budgetFinancial);
  const native = nativeCustodyConfigSchema.safeParse(keeper.budgetNative);
  const gateway = gatewayBudgetConfigSchema.safeParse(keeper.gatewayBudget);
  if (!financial.success || !native.success || !gateway.success ||
      keeper.designatedOwnerId !== installation.LARES_OWNER_ID || keeper.publicDoorOrigin !== `https://${installation.LARES_DOMAIN}` ||
      sources.gateway.alias !== installation.LARES_MODEL_ALIAS || sources.gateway.providerModel !== installation.LARES_MODEL ||
      selection.ownerId !== installation.LARES_OWNER_ID || selection.organisationId !== installation.LARES_DOMAIN ||
      selection.installationOrigin !== `https://${installation.LARES_DOMAIN}` ||
      gateway.data.serviceKeyFile !== sources.expectedServiceKeyFile ||
      gateway.data.serviceKeyFile !== join(sources.secretsDir, SERVICE_KEY_NAME) ||
      !native.data.reviewedPolicyFile || !financial.data.directory) {
    throw new Error("gateway authority prerequisites are missing or inconsistent");
  }
  const originUrl = new URL(selection.installationOrigin);
  if (originUrl.origin !== selection.installationOrigin || originUrl.protocol !== "https:" || originUrl.username || originUrl.password ||
      originUrl.pathname !== "/" || originUrl.search || originUrl.hash) throw new Error("confirmed installation origin is not canonical");

  validateServiceKey(gateway.data.serviceKeyFile, sources.secretsDir);
  safeAncestors(native.data.reviewedPolicyFile);
  const policy = readBudgetNativePolicyDocument(native.data.reviewedPolicyFile);
  const profile = gatewayAdmissionProfile(sources.gateway);
  for (const reviewed of policy.policies) {
    if (!gatewayCanonical(reviewed.capability).equals(gatewayCanonical(profile)))
      throw new Error("reviewed native policy does not match the rendered gateway profile");
  }
  if (captureSourceCommitment(sources) !== sourceCommitment)
    throw new Error("gateway authority sources changed during validation");
  return {
    origin: selection.installationOrigin,
    endpointHash: policy.endpointHash,
    serviceKeyFile: gateway.data.serviceKeyFile,
    policyFile: native.data.reviewedPolicyFile,
    ownerId: installation.LARES_OWNER_ID,
    domain: installation.LARES_DOMAIN,
    modelAlias: installation.LARES_MODEL_ALIAS,
    providerModel: installation.LARES_MODEL,
    consoleAllowedEmails: installation.CONSOLE_ALLOWED_EMAILS!,
    ownerEmail: installation.LARES_OWNER_EMAIL!,
    ownerHomeTz: installation.OWNER_HOME_TZ ?? "",
    gatewayUrl: installation.GATEWAY_URL!,
    previousKeeperConfig: keeper,
    sourceCommitment,
  };
}

export function recheckGatewayAuthoritySources(sources: GatewayAuthoritySources, expected: string): void {
  if (!/^[a-f0-9]{64}$/.test(expected) || captureSourceCommitment(sources) !== expected)
    throw new Error("gateway authority sources changed after validation");
}
