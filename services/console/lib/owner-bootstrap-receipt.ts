import { createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { providerIdentitySchema, type ProviderIdentity } from "@lares/agent-kit/authority-contract";
import { readSecret } from "./secrets";

export const OWNER_DISCOVERY_COOKIE = "lares_owner_discovery";
export const OWNER_DISCOVERY_MAX_AGE = 300;
export interface OwnerBootstrapSelection {
  ownerId: string;
  organisationId: string;
  installationOrigin: string;
  identity: ProviderIdentity;
  digest: string;
}
export interface OwnerDiscoveryReceipt {
  installationOrigin: string;
  identity: ProviderIdentity;
  digest: string;
}

function key(): Uint8Array {
  const secret = readSecret("CONSOLE_SESSION_SECRET")?.trim();
  if (!secret) throw new Error("Console sign-in is not configured");
  return createHash("sha256").update(secret).digest();
}
function normalizedIdentity(value: unknown): ProviderIdentity {
  const parsed = providerIdentitySchema.parse(value);
  return { issuer: parsed.issuer, subject: parsed.subject, ...(parsed.tenantId === undefined ? {} : { tenantId: parsed.tenantId }) };
}
export function ownerDiscoveryDigest(installationOrigin: string, identity: ProviderIdentity): string {
  const normalized = normalizedIdentity(identity);
  return createHash("sha256").update(JSON.stringify({ purpose: "lares-owner-discovery-v1", installationOrigin, identity: normalized })).digest("hex");
}
export function ownerBootstrapDigest(ownerId: string, organisationId: string, installationOrigin: string, identity: ProviderIdentity): string {
  const normalized = normalizedIdentity(identity);
  return createHash("sha256").update(JSON.stringify({ purpose: "lares-owner-bootstrap-v1", ownerId, organisationId, installationOrigin, identity: normalized })).digest("hex");
}
export function parseOwnerBootstrapSelection(value: unknown): OwnerBootstrapSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid discovery receipt");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "digest,identity,installationOrigin,organisationId,ownerId" ||
      typeof record.ownerId !== "string" || !record.ownerId.trim() ||
      typeof record.organisationId !== "string" || !record.organisationId ||
      typeof record.installationOrigin !== "string" || !/^https:\/\/[^/]+$/.test(record.installationOrigin) ||
      typeof record.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.digest)) throw new Error("Invalid discovery receipt");
  const identity = normalizedIdentity(record.identity);
  const expected = ownerBootstrapDigest(record.ownerId, record.organisationId, record.installationOrigin, identity);
  const actualBytes = Buffer.from(record.digest, "hex"), expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new Error("Invalid discovery receipt");
  return { ownerId: record.ownerId, organisationId: record.organisationId, installationOrigin: record.installationOrigin, identity, digest: record.digest };
}
export function parseOwnerDiscoveryReceipt(value: unknown): OwnerDiscoveryReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid discovery receipt");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "digest,identity,installationOrigin" ||
      typeof record.installationOrigin !== "string" || !/^https:\/\/[^/]+$/.test(record.installationOrigin) ||
      typeof record.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.digest)) throw new Error("Invalid discovery receipt");
  const identity = normalizedIdentity(record.identity);
  const expected = ownerDiscoveryDigest(record.installationOrigin, identity);
  const actualBytes = Buffer.from(record.digest, "hex"), expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new Error("Invalid discovery receipt");
  return { installationOrigin: record.installationOrigin, identity, digest: record.digest };
}
export function selectionFromDiscovery(receipt: OwnerDiscoveryReceipt, ownerId: string, organisationId: string): OwnerBootstrapSelection {
  const discovery = parseOwnerDiscoveryReceipt(receipt);
  const identity = discovery.identity;
  const digest = ownerBootstrapDigest(ownerId, organisationId, discovery.installationOrigin, identity);
  return { ownerId, organisationId, installationOrigin: discovery.installationOrigin, identity, digest };
}
export async function sealOwnerDiscoveryReceipt(receipt: OwnerDiscoveryReceipt): Promise<string> {
  const parsed = parseOwnerDiscoveryReceipt(receipt);
  return new SignJWT({ installationOrigin: parsed.installationOrigin, identity: parsed.identity, digest: parsed.digest })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("lares-console-owner-discovery")
    .setAudience("lares-console-owner-discovery-display").setIssuedAt().setExpirationTime(`${OWNER_DISCOVERY_MAX_AGE}s`).sign(key());
}
export async function openOwnerDiscoveryReceipt(value: string | undefined): Promise<OwnerDiscoveryReceipt | null> {
  if (!value) return null;
  try {
    const { payload } = await jwtVerify(value, key(), {
      algorithms: ["HS256"], issuer: "lares-console-owner-discovery", audience: "lares-console-owner-discovery-display",
      maxTokenAge: `${OWNER_DISCOVERY_MAX_AGE}s`, clockTolerance: 0,
    });
    if (Object.keys(payload).some(field => !["iss", "aud", "iat", "exp", "installationOrigin", "identity", "digest"].includes(field))) return null;
    return parseOwnerDiscoveryReceipt({ installationOrigin: payload.installationOrigin, identity: payload.identity, digest: payload.digest });
  } catch { return null; }
}
