/**
 * Who eve-marcel trusts — a single fail-closed admin id, read from
 * `MARCEL_ADMIN_TELEGRAM_ID` (`services/box/compose.yaml`'s eve-marcel: block).
 *
 * Simpler than eve-saga's `lib/principals.ts` (a channel→allowed-ids map covering Slack AND
 * Telegram): Marcel has exactly one door, Telegram, and exactly one trusted human (Bendik), so
 * there is one id to check, not a per-channel list.
 *
 * Fail-closed: unset, blank, or a non-matching candidate id all refuse. There is no default
 * admin — a missing env var must admit nobody, never fall back to "anyone".
 */
export function isAllowedAdmin(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (id.length === 0) return false;
  const configured = (env.LARES_AGENT_INCARNATION ? env.LARES_TELEGRAM_PRINCIPAL ?? "" : env["MARCEL_ADMIN_TELEGRAM_ID"] ?? "").trim();
  if (configured.length === 0) return false;
  return id === configured;
}

// ─── Who Marcel speaks FOR, and through which door (ORB-193) ─────────────────────────────
//
// The two keys the proactivity ledger (`initiations`) is written under. They live here, beside
// the admin check, because they are the same kind of fact — identity, per install, never a
// literal in a schedule — and because they must be the SAME strings eve-saga writes
// (`services/chief-of-staff/lib/principals.ts`): Marcel's trip posts into a Telegram chat and Saga's
// own sends into that chat have to land on one counter, or a per-door ceiling counts two doors
// where the owner has one phone.

/** The only channel Marcel has. (eve-saga's own `ChannelName` also carries `"slack"`.) */
export type ChannelName = "telegram";

/** The configured canonical owner id, read at operation time. Missing/blank
 * configuration refuses instead of assigning another person's identity. */
export function ownerId(env: NodeJS.ProcessEnv = process.env): string {
  const owner = env["AGENT_OWNER_USER_ID"]?.trim();
  if (!owner) throw new Error("Owner identity is not configured: set AGENT_OWNER_USER_ID");
  return owner;
}

/** A door id for the ledger: `telegram:<chatId>`. */
export function doorId(kind: ChannelName, id: string): string {
  return `${kind}:${id}`;
}
