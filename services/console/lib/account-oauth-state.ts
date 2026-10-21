/** Server-only, short-lived consent cookie. State alone never permits callback replay. */
import { createHash } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { readSecret } from "./secrets";

export const ACCOUNT_FLOW_COOKIE = "lares_account_consent";
export const ACCOUNT_FLOW_MAX_AGE = 600;
interface FlowBase { memberId: string; sessionHash: string; org: string; clientId: string; state: string; nonce: string; verifier: string }
export type AccountFlow = FlowBase & ({ intent: "new" } | { intent: "reconnect"; update: { accountId: string; generation: number; lifecycleRevision: number } });
function parseFlow(value: unknown): AccountFlow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid consent flow");
  const flow = value as Record<string, unknown>;
  const fields = ["memberId", "sessionHash", "org", "clientId", "state", "nonce", "verifier"];
  if (fields.some(field => typeof flow[field] !== "string" || !flow[field]) || !/^[a-z0-9]+$/.test(String(flow.org))) throw new Error("Invalid consent flow");
  const allowed = [...fields,"intent",...(flow.intent === "reconnect" ? ["update"] : [])];
  if (Object.keys(flow).some(field => !allowed.includes(field))) throw new Error("Invalid consent flow");
  const common: FlowBase = { memberId: String(flow.memberId), sessionHash: String(flow.sessionHash), org: String(flow.org),
    clientId: String(flow.clientId), state: String(flow.state), nonce: String(flow.nonce), verifier: String(flow.verifier) };
  if (flow.intent === "new") return { ...common, intent: "new" };
  if (flow.intent !== "reconnect" || !flow.update || typeof flow.update !== "object" || Array.isArray(flow.update)) throw new Error("Invalid consent intent");
  const update = flow.update as Record<string,unknown>;
  if (Object.keys(update).sort().join(",") !== "accountId,generation,lifecycleRevision" || typeof update.accountId !== "string" || !update.accountId ||
    !Number.isSafeInteger(update.generation) || Number(update.generation) < 0 || !Number.isSafeInteger(update.lifecycleRevision) || Number(update.lifecycleRevision) < 0) throw new Error("Invalid reconnect ticket");
  return { ...common, intent: "reconnect", update: { accountId: update.accountId, generation: Number(update.generation), lifecycleRevision: Number(update.lifecycleRevision) } };
}
function key(): Uint8Array {
  const secret = [readSecret("CONSOLE_SESSION_SECRET"), process.env.CONSOLE_SESSION_SECRET]
    .find(value => typeof value === "string" && value.trim());
  if (!secret) throw new Error("Account consent is not configured");
  return createHash("sha256").update(secret.trim()).digest();
}
export function accountSessionHash(session: string): string { return createHash("sha256").update(session).digest("base64url"); }
export async function sealAccountFlow(input: AccountFlow): Promise<string> {
  const flow = parseFlow(input);
  return new EncryptJWT({ flow }).setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer("lares-account-consent").setAudience("lares-account-callback")
    .setIssuedAt().setExpirationTime("10m").encrypt(key());
}
export async function openAccountFlow(value: string | undefined): Promise<AccountFlow | null> {
  if (!value) return null;
  try {
    const { payload } = await jwtDecrypt(value, key(), { issuer: "lares-account-consent", audience: "lares-account-callback",
      keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
    return parseFlow(payload.flow);
  } catch { return null; }
}
