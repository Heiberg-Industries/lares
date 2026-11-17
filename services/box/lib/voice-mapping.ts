// services/box/lib/voice-mapping.ts — the one-time move of today's mailbox voices onto members.
//
// WHAT IT DOES. Today a writing voice is filed under a mailbox's address: one card per mailbox in
// `voice_profile` plus the shared `default` card, and the examples in `voice_exemplar`. Migration
// 037_person_voice_profiles.sql added a person profile table and empty owner/account columns. This
// routine fills them, after a report that can fail:
//   - each mailbox is linked to ONE connected account, and through it to that account's member
//     (`connected_accounts.owner_member_id`). The mailbox is matched to an account only when exactly
//     one account's Google-verified address, as stored with its credential (`oauth_tokens`, reached
//     only through `connected_account_credentials`), equals the mailbox exactly; or when the owner
//     names the account with `--map`. A member is never found from a person's own email address or a
//     display name. Anything else is held, and the report says why in plain words;
//   - the shared `default` card is copied into the installation owner's profile, only when exactly one
//     active owner exists and the agent named in the card's learn settings belongs to that same owner;
//   - a learn left marked "running" is marked "interrupted". It is not restarted;
//   - the old blended examples (`legacy:blended`) are never linked to anybody.
// Nothing else changes: card text, examples, exclusions, pending proposed cards, learn settings and
// relearn requests stay exactly as they are. The routine only fills empty columns, so running it
// again links what is new (for example examples learned since) and leaves the rest alone.
//
// DRY RUN IS THE DEFAULT and opens a read-only transaction. `apply` recomputes the same plan inside
// one serializable transaction, writes, checks the result against fingerprints taken before the
// writes, and commits only if everything matches; otherwise it rolls back and changes nothing.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export const LEGACY_BLENDED = "legacy:blended";
const LANGS = [["en", "English"], ["no", "Norwegian"]] as const;
type Lang = (typeof LANGS)[number][0];

export class VoiceMappingUsageError extends Error {}

/** `<mailbox>=<account id>` from the command line, checked for shape only. */
export function parseMapArgument(value: string): { mailbox: string; accountId: string } {
  const at = value.lastIndexOf("=");
  const mailbox = at > 0 ? value.slice(0, at).trim() : "";
  const accountId = at > 0 ? value.slice(at + 1).trim() : "";
  if (!mailbox || !accountId) throw new VoiceMappingUsageError(`--map needs <mailbox>=<account id>, for example owner@example.invalid=acct-1 (got "${value}").`);
  return { mailbox, accountId };
}

interface Card { core: string; notes_en: string; notes_no: string }
interface ProfileRow extends Card {
  id: string; model_en: string | null; model_no: string | null; learn_key: string; learn_status: string;
  has_proposed: boolean; owner_member_id: string | null; connected_account_id: string | null;
}
interface ExemplarGroup { mailbox: string; lang: string; included: boolean; owner_member_id: string | null; connected_account_id: string | null; n: number }
interface AccountRow { id: string; owner_member_id: string; connector_id: string; status: string; email_address: string | null; has_credential: boolean }

export type MailboxDecision =
  | { kind: "linked"; memberId: string; accountId: string; how: "before" | "address" | "map"; note?: string }
  | { kind: "held"; reason: string }
  | { kind: "conflict"; reason: string };

export interface MailboxPlan {
  mailbox: string;
  hasCard: boolean;
  decision: MailboxDecision;
  examples: { lang: string; included: number; excluded: number }[];
  /** Rows this run would link (card row counts as one). */
  toLink: { card: boolean; examples: number };
  learnRunning: boolean;
  hasProposed: boolean;
  modelOverrides: string[];
  voices: { lang: string; line: string }[];
}

export interface DefaultPlan {
  present: boolean;
  /** The member whose new profile gets a copy, or null when held or not needed. */
  copyTo: string | null;
  line: string;
}

export interface VoiceMappingPlan {
  mailboxes: MailboxPlan[];
  defaultCard: DefaultPlan;
  counts: { cards: number; mailboxCards: number; examples: number; legacyBlended: number; unlinkedCards: number; unlinkedExamples: number; profiles: number };
  running: string[];
  learnRecentlyActive: boolean;
  /** Each one stops `apply`. */
  blocking: string[];
  fingerprints: { voiceProfile: string; voiceExemplar: string };
}

const hasText = (c: Card | undefined | null): boolean => !!c && [c.core, c.notes_en, c.notes_no].some((v) => (v ?? "").trim() !== "");
const voiceText = (c: Card, lang: Lang): string =>
  [c.core?.trim(), (lang === "no" ? c.notes_no : c.notes_en)?.trim()].filter((s) => !!s).join("\n\n");
const short = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Fingerprints of every column the routine must NOT change. A learn status of "running" counts the
 *  same as "interrupted", because that one change is the routine's own. */
async function fingerprints(db: Pick<PoolClient, "query">): Promise<VoiceMappingPlan["fingerprints"]> {
  const p = await db.query<{ f: string | null }>(`SELECT md5(coalesce(string_agg(md5(ROW(id, core, notes_en, notes_no, model_en, model_no,
      learn_key, learn_lookback_days, learn_cap, proposed, relearn_requested_at,
      CASE WHEN learn_status IN ('running','interrupted') THEN 'running-or-interrupted' ELSE learn_status END,
      learn_message, updated_by, updated_at)::text), ',' ORDER BY id), '')) AS f FROM voice_profile`);
  const e = await db.query<{ f: string | null }>(`SELECT md5(coalesce(string_agg(md5(ROW(mailbox, id, lang, text, vector, source_message_id,
      included, created_at)::text), ',' ORDER BY mailbox, id), '')) AS f FROM voice_exemplar`);
  return { voiceProfile: p.rows[0]?.f ?? "", voiceExemplar: e.rows[0]?.f ?? "" };
}

/** True when migration 037 has been applied. */
async function hasProfiles(db: Pick<PoolClient, "query">): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(`SELECT to_regclass('public.person_voice_profiles') IS NOT NULL AS ok`);
  return rows[0]?.ok === true;
}

export class VoiceMappingNotReady extends Error {}

/** What the owner asked for on the command line. */
export interface VoiceMappingOptions {
  maps?: ReadonlyArray<{ mailbox: string; accountId: string }>;
  /** Who gets the shared default card when it is held because the owner is not clear. */
  defaultOwner?: string;
}

export async function planVoiceMapping(
  db: Pick<PoolClient, "query">,
  opts: VoiceMappingOptions = {},
): Promise<VoiceMappingPlan> {
  const maps = opts.maps ?? [];
  if (!(await hasProfiles(db))) {
    throw new VoiceMappingNotReady("This database does not have person voice profiles yet: the update that adds them " +
      "(037_person_voice_profiles.sql) has not been applied. Update Lares first.");
  }
  const profiles = (await db.query<ProfileRow>(`SELECT id, core, notes_en, notes_no, model_en, model_no, learn_key, learn_status,
      proposed IS NOT NULL AS has_proposed, owner_member_id, connected_account_id FROM voice_profile ORDER BY id`)).rows;
  const groups = (await db.query<ExemplarGroup>(`SELECT mailbox, lang, included, owner_member_id, connected_account_id, count(*)::int AS n
      FROM voice_exemplar GROUP BY mailbox, lang, included, owner_member_id, connected_account_id`)).rows;
  const accounts = (await db.query<AccountRow>(`SELECT a.id, a.owner_member_id, a.connector_id, a.status, t.email_address,
      c.account_id IS NOT NULL AS has_credential
      FROM connected_accounts a
      LEFT JOIN connected_account_credentials c ON c.account_id = a.id AND c.owner_member_id = a.owner_member_id
      LEFT JOIN oauth_tokens t ON t.id = c.oauth_token_id
      ORDER BY a.id`)).rows;
  const owners = (await db.query<{ id: string }>(`SELECT id FROM users WHERE org_role = 'owner' AND status = 'active' ORDER BY id`)).rows.map((r) => r.id);
  const existingProfiles = new Map((await db.query<Card & { owner_member_id: string }>(
    `SELECT owner_member_id, core, notes_en, notes_no FROM person_voice_profiles`)).rows.map((r) => [r.owner_member_id, r]));
  const learnRecentlyActive = (await db.query<{ active: boolean }>(`SELECT EXISTS (SELECT 1 FROM heartbeat
      WHERE agent LIKE '%/voice-learn/tick' AND updated_at > now() - interval '5 minutes') AS active`)).rows[0]?.active === true;

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const cardOf = new Map(profiles.map((p) => [p.id, p]));
  const def = cardOf.get("default");
  const blocking: string[] = [];

  // ── The shared default card ──────────────────────────────────────────────────────────────
  let defaultCard: DefaultPlan;
  if (!def) {
    defaultCard = { present: false, copyTo: null, line: "There is no shared default card, so there is nothing to copy into a profile." };
  } else {
    // The installation owner. Nothing records whose the shared card is, so exactly one active
    // owner decides it; otherwise the owner names one with --default-owner.
    const copy = (member: string, how: string): DefaultPlan => existingProfiles.has(member)
      ? { present: true, copyTo: null, line: `${member} already has a profile. It is left as it is; the shared default card is not copied again.` }
      : { present: true, copyTo: member, line: `The shared default card (its text and its English and Norwegian model choices) is copied into a new profile for ${how}, ${member}.` };
    if (opts.defaultOwner !== undefined) {
      if (owners.includes(opts.defaultOwner)) {
        defaultCard = copy(opts.defaultOwner, "the installation owner you named with --default-owner");
      } else {
        defaultCard = { present: true, copyTo: null, line: `Held: you named ${opts.defaultOwner} with --default-owner, but ${opts.defaultOwner} is not an active member with the owner role.` };
        blocking.push(`--default-owner: ${opts.defaultOwner} is not an active member with the owner role, so the shared default card cannot be given to them.`);
      }
    } else if (owners.length === 0) {
      defaultCard = { present: true, copyTo: null, line: "Held: no active installation owner was found, so the shared default card was not given to anyone." };
    } else if (owners.length > 1) {
      defaultCard = { present: true, copyTo: null, line: `Held: there are ${owners.length} active installation owners (${owners.join(", ")}), so it is not clear whose the shared default card is. To give it to one of them, add --default-owner <member id>.` };
    } else {
      defaultCard = copy(owners[0]!, "the installation owner");
    }
  }
  /** The common card a member would have after this run. */
  const commonFor = (member: string): Card | null =>
    existingProfiles.get(member) ?? (member === defaultCard.copyTo && def ? def : null);

  // ── Which mailboxes there are ────────────────────────────────────────────────────────────
  const names = new Set<string>();
  // `default` is the shared card, never a mailbox, even if an example was ever filed under that name.
  for (const p of profiles) if (p.id !== "default") names.add(p.id);
  for (const g of groups) if (g.mailbox !== LEGACY_BLENDED && g.mailbox !== "default") names.add(g.mailbox);
  const mapped = new Map<string, string>();
  for (const m of maps) {
    if (!names.has(m.mailbox)) throw new VoiceMappingUsageError(`--map names ${m.mailbox}, but no voice card or examples are filed under that mailbox.`);
    if (mapped.has(m.mailbox) && mapped.get(m.mailbox) !== m.accountId) throw new VoiceMappingUsageError(`--map names ${m.mailbox} twice, with two different accounts.`);
    mapped.set(m.mailbox, m.accountId);
  }

  const mailboxes: MailboxPlan[] = [];
  for (const mailbox of [...names].sort()) {
    const card = cardOf.get(mailbox);
    const mine = groups.filter((g) => g.mailbox === mailbox);
    const links = new Set<string>();
    const formerOwners = new Set<string>();
    if (card?.connected_account_id) links.add(card.connected_account_id);
    else if (card?.owner_member_id) formerOwners.add(card.owner_member_id);
    for (const g of mine) {
      if (g.connected_account_id) links.add(g.connected_account_id);
      else if (g.owner_member_id) formerOwners.add(g.owner_member_id);
    }
    let decision: MailboxDecision;
    const asked = mapped.get(mailbox);
    if (links.size > 1) {
      decision = { kind: "conflict", reason: `Its card and examples are already linked to more than one account (${[...links].sort().join(", ")}). Nothing is changed for it until that is sorted out.` };
    } else if (links.size === 1) {
      const accountId = [...links][0]!;
      const account = byId.get(accountId)!;
      decision = asked && asked !== accountId
        ? { kind: "conflict", reason: `You asked to link it to account ${asked}, but it is already linked to account ${accountId}. This command does not move a linked mailbox.` }
        : { kind: "linked", memberId: account.owner_member_id, accountId, how: "before" };
    } else if (asked) {
      const account = byId.get(asked);
      if (!account) decision = { kind: "conflict", reason: `You asked to link it to account ${asked}, but Lares has no connected account with that id.` };
      else if (account.connector_id !== "google" || !account.has_credential) decision = { kind: "conflict", reason: `You asked to link it to account ${asked}, but that account has no Google sign-in stored in Lares, so it cannot be a mailbox.` };
      else {
        const note = account.email_address !== mailbox ? `The account's stored Google address is ${account.email_address ?? "unknown"}, not ${mailbox}; it is linked because you asked.` : undefined;
        decision = { kind: "linked", memberId: account.owner_member_id, accountId: account.id, how: "map", ...(note ? { note } : {}) };
      }
    } else {
      const google = accounts.filter((a) => a.connector_id === "google" && a.has_credential);
      const exact = google.filter((a) => a.email_address === mailbox);
      const loose = google.filter((a) => a.email_address !== null && a.email_address !== mailbox && a.email_address.toLowerCase() === mailbox.toLowerCase());
      if (exact.length === 1) decision = { kind: "linked", memberId: exact[0]!.owner_member_id, accountId: exact[0]!.id, how: "address" };
      else if (exact.length > 1) decision = { kind: "held", reason: `${exact.length} connected accounts have exactly this address (${exact.map((a) => `account ${a.id} of ${a.owner_member_id}`).join("; ")}), for example because two members connected the same Google account. Choose one with --map ${mailbox}=<account id>.` };
      else if (loose.length > 0) decision = { kind: "held", reason: `A connected account has this address only when capital and small letters are treated as the same (${loose.map((a) => `account ${a.id}`).join(", ")}). Lares does not link on that alone; to link it, use --map ${mailbox}=<account id>.` };
      else decision = { kind: "held", reason: `No connected account in Lares has this address. If the mailbox is still connected under another address, link it with --map ${mailbox}=<account id>; otherwise it stays held.` };
    }
    if (decision.kind === "linked" && [...formerOwners].some((o) => o !== (decision as { memberId: string }).memberId)) {
      decision = { kind: "conflict", reason: `Part of it is already linked to another member (${[...formerOwners].sort().join(", ")}), whose account has since been removed. Nothing is changed for it.` };
    }

    const toLink = { card: false, examples: 0 };
    if (decision.kind === "linked") {
      const free = (owner: string | null, account: string | null) => account === null && (owner === null || owner === (decision as { memberId: string }).memberId);
      toLink.card = !!card && free(card.owner_member_id, card.connected_account_id);
      toLink.examples = mine.filter((g) => free(g.owner_member_id, g.connected_account_id)).reduce((n, g) => n + g.n, 0);
    }

    const examples = LANGS.map(([lang]) => ({
      lang,
      included: mine.filter((g) => g.lang === lang && g.included).reduce((n, g) => n + g.n, 0),
      excluded: mine.filter((g) => g.lang === lang && !g.included).reduce((n, g) => n + g.n, 0),
    }));

    const voices = LANGS.map(([lang, label]) => {
      const today = hasText(card) ? { from: "its own card", text: voiceText(card!, lang) }
        : hasText(def) ? { from: "the shared default card", text: voiceText(def!, lang) }
        : { from: "no card", text: "" };
      if (decision.kind !== "linked") return { lang, line: `${label}: today ${today.from}${today.text ? ` (fingerprint ${short(today.text)})` : ""}; what it becomes is decided once the mailbox is linked.` };
      if (hasText(card)) return { lang, line: `${label}: its own card, unchanged (fingerprint ${today.text ? short(today.text) : "empty"}).` };
      const common = commonFor(decision.memberId);
      const after = hasText(common) ? voiceText(common!, lang) : "";
      const afterFrom = hasText(common) ? `${decision.memberId}'s profile` : `no voice (${decision.memberId} has no profile text)`;
      const verdict = after === today.text ? "the same text" : "different text";
      return { lang, line: `${label}: today ${today.from}; once agents read person profiles, ${afterFrom}: ${verdict}${after ? ` (fingerprint ${short(after)})` : ""}.` };
    });

    mailboxes.push({
      mailbox, hasCard: !!card, decision, examples, toLink,
      learnRunning: card?.learn_status === "running",
      hasProposed: card?.has_proposed === true,
      modelOverrides: card ? [card.model_en, card.model_no].filter((m): m is string => !!m && m.trim() !== "") : [],
      voices,
    });
  }

  // Two mailboxes on one account: one account has one mailbox card.
  const perAccount = new Map<string, string[]>();
  for (const m of mailboxes) if (m.decision.kind === "linked") perAccount.set(m.decision.accountId, [...(perAccount.get(m.decision.accountId) ?? []), m.mailbox]);
  for (const [accountId, list] of perAccount) {
    if (list.length < 2) continue;
    for (const m of mailboxes) {
      if (!list.includes(m.mailbox)) continue;
      m.decision = { kind: "conflict", reason: `It and ${list.filter((x) => x !== m.mailbox).join(", ")} would both be linked to account ${accountId}. One account has one mailbox card.` };
      m.toLink = { card: false, examples: 0 };
    }
  }
  for (const m of mailboxes) if (m.decision.kind === "conflict") blocking.push(`${m.mailbox}: ${m.decision.reason}`);

  // A learn marked "running" is marked "interrupted" even while the agent is up. That is safe: a learn
  // that really is in progress writes its own status again when it finishes or fails
  // (chief-of-staff lib/voice-learn.ts, runVoiceLearn). If the learn writes a card this run is about to
  // update, and that write was committed after this run's snapshot (or is still uncommitted), the run's
  // UPDATE fails with a serialization failure (40001) and nothing is changed; if this run writes the
  // card first, the learn's own status write waits for the commit and then replaces the mark. Exemplar
  // rows the learn inserts during the run are not seen here: they stay unlinked until the next run. The
  // report explains this when a card is marked running and the schedule checked in recently.
  const running = profiles.filter((p) => p.learn_status === "running").map((p) => p.id);

  const sum = (f: (g: ExemplarGroup) => boolean) => groups.filter(f).reduce((n, g) => n + g.n, 0);
  return {
    mailboxes,
    defaultCard,
    counts: {
      cards: profiles.length,
      mailboxCards: profiles.filter((p) => p.id !== "default").length,
      examples: sum(() => true),
      legacyBlended: sum((g) => g.mailbox === LEGACY_BLENDED),
      unlinkedCards: profiles.filter((p) => p.id !== "default" && p.connected_account_id === null).length,
      unlinkedExamples: sum((g) => g.mailbox !== LEGACY_BLENDED && g.connected_account_id === null),
      profiles: existingProfiles.size,
    },
    running,
    learnRecentlyActive,
    blocking,
    fingerprints: await fingerprints(db),
  };
}

export type ApplyOutcome =
  | { kind: "applied"; plan: VoiceMappingPlan; linkedCards: number; linkedExamples: number; profileCreated: boolean; interrupted: number }
  | { kind: "refused"; plan: VoiceMappingPlan }
  | { kind: "failed"; reason: string };

/** Read-only: the plan, from one consistent snapshot. */
export async function dryRunVoiceMapping(pool: Pool, opts: VoiceMappingOptions = {}): Promise<VoiceMappingPlan> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await planVoiceMapping(client, opts);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** The plan again, inside one serializable transaction; writes; checks; commits or changes nothing. */
export async function applyVoiceMapping(pool: Pool, opts: VoiceMappingOptions = {}): Promise<ApplyOutcome> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const plan = await planVoiceMapping(client, opts);
    if (plan.blocking.length > 0) return { kind: "refused", plan };

    let linkedCards = 0, linkedExamples = 0;
    for (const m of plan.mailboxes) {
      if (m.decision.kind !== "linked") continue;
      const params = [m.mailbox, m.decision.memberId, m.decision.accountId];
      const free = "connected_account_id IS NULL AND (owner_member_id IS NULL OR owner_member_id = $2)";
      linkedCards += (await client.query(`UPDATE voice_profile SET owner_member_id = $2, connected_account_id = $3, mapped_at = clock_timestamp()
          WHERE id = $1 AND ${free}`, params)).rowCount ?? 0;
      linkedExamples += (await client.query(`UPDATE voice_exemplar SET owner_member_id = $2, connected_account_id = $3
          WHERE mailbox = $1 AND ${free}`, params)).rowCount ?? 0;
    }
    let profileCreated = false;
    if (plan.defaultCard.copyTo) {
      profileCreated = ((await client.query(`INSERT INTO person_voice_profiles (owner_member_id, core, notes_en, notes_no, model_en, model_no, created_from)
          SELECT $1, core, notes_en, notes_no, model_en, model_no, 'mapping' FROM voice_profile WHERE id = 'default'
          ON CONFLICT (owner_member_id) DO NOTHING`, [plan.defaultCard.copyTo])).rowCount ?? 0) === 1;
    }
    const interrupted = (await client.query(`UPDATE voice_profile SET learn_status = 'interrupted' WHERE learn_status = 'running'`)).rowCount ?? 0;

    // The check: nothing else moved, and everything planned happened.
    const after = await fingerprints(client);
    const wantCards = plan.mailboxes.filter((m) => m.toLink.card).length;
    const wantExamples = plan.mailboxes.reduce((n, m) => n + m.toLink.examples, 0);
    const problems: string[] = [];
    if (after.voiceProfile !== plan.fingerprints.voiceProfile) problems.push("the mailbox cards changed in a way this command does not make");
    if (after.voiceExemplar !== plan.fingerprints.voiceExemplar) problems.push("the writing examples changed in a way this command does not make");
    if (linkedCards !== wantCards) problems.push(`${linkedCards} mailbox cards were linked, but the report planned ${wantCards}`);
    if (linkedExamples !== wantExamples) problems.push(`${linkedExamples} examples were linked, but the report planned ${wantExamples}`);
    if (interrupted !== plan.running.length) problems.push(`${interrupted} learns were marked interrupted, but the report found ${plan.running.length}`);
    if (plan.defaultCard.copyTo && !profileCreated) problems.push("the owner's profile was not created as planned");
    const legacy = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM voice_exemplar WHERE mailbox = $1 AND owner_member_id IS NOT NULL`, [LEGACY_BLENDED])).rows[0]?.n ?? 0;
    if (legacy !== 0) problems.push("old blended examples were linked to a member");
    if (problems.length > 0) {
      await client.query("ROLLBACK");
      return { kind: "failed", reason: `The check after the changes did not match (${problems.join("; ")}), so they were all undone.` };
    }
    await client.query("COMMIT");
    committed = true;
    return { kind: "applied", plan, linkedCards, linkedExamples, profileCreated, interrupted };
  } catch (err) {
    if (err instanceof VoiceMappingUsageError || err instanceof VoiceMappingNotReady) throw err;
    // 40001 / 40P01: another write to the same rows (for example a voice learn) got there first.
    const code = (err as { code?: unknown }).code;
    const again = code === "40001" || code === "40P01" ? " Something else wrote to the voice data at the same moment; run the same command again." : "";
    return { kind: "failed", reason: `The database stopped the run (${err instanceof Error ? err.message : String(err)}), so nothing was changed.${again}` };
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** The report, for the owner. Plain words; every count is what the plan found. */
export function renderVoiceMappingReport(plan: VoiceMappingPlan, mode: "dry-run" | "applied" | "refused"): string {
  const out: string[] = [];
  const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  out.push("# Linking mailbox voices to members");
  out.push("");
  if (mode === "dry-run") out.push("This is a report only. Nothing was changed. To make these changes, run the same command again with --apply.");
  else if (mode === "applied") out.push("Done. The changes below were made together, in one go, and checked afterwards.");
  else out.push("Nothing was changed. --apply was refused because of the problems listed under \"Stops --apply\".");
  out.push("");
  out.push("## What is there");
  out.push(`- ${s(plan.counts.mailboxCards, "mailbox card")} and ${plan.counts.cards > plan.counts.mailboxCards ? "the shared default card" : "no shared default card"}.`);
  out.push(`- ${s(plan.counts.examples, "writing example")}, of which ${plan.counts.legacyBlended} ${plan.counts.legacyBlended === 1 ? "is an old blended example" : "are old blended examples"}. Old blended examples are never linked to anyone and stay out of use.`);
  out.push(`- Not linked to an account yet: ${s(plan.counts.unlinkedCards, "mailbox card")} and ${s(plan.counts.unlinkedExamples, "example")} (old blended examples not counted).`);
  out.push(`- Person profiles that already exist: ${plan.counts.profiles}.`);
  out.push(`- Fingerprints of the existing cards and examples: ${plan.fingerprints.voiceProfile.slice(0, 12)} and ${plan.fingerprints.voiceExemplar.slice(0, 12)}. --apply checks that these are unchanged afterwards (apart from a running learn marked interrupted).`);
  out.push("");
  out.push("## The shared default card");
  out.push(`- ${plan.defaultCard.line}`);
  out.push("");
  out.push("## Mailboxes");
  if (plan.mailboxes.length === 0) out.push("- None. No mailbox has a card or examples.");
  for (const m of plan.mailboxes) {
    out.push("");
    out.push(`### ${m.mailbox}`);
    const d = m.decision;
    if (d.kind === "linked") {
      const how = d.how === "before" ? "already linked" : d.how === "address" ? "matched by its address" : "linked as you asked with --map";
      out.push(`- Account ${d.accountId}, member ${d.memberId} (${how}).`);
      if (d.note) out.push(`- ${d.note}`);
      const parts = [m.toLink.card ? "its card" : "", m.toLink.examples > 0 ? s(m.toLink.examples, "example") : ""].filter(Boolean);
      out.push(parts.length > 0 ? `- ${mode === "applied" ? "Linked now" : "Would be linked now"}: ${parts.join(" and ")}.` : "- Nothing new to link.");
    } else if (d.kind === "held") {
      out.push(`- Held, not linked: ${d.reason}`);
    } else {
      out.push(`- Problem: ${d.reason}`);
    }
    out.push(`- ${m.hasCard ? "Has its own card" : "Has no card of its own"}. Examples: ${m.examples.map((e) => `${e.lang === "en" ? "English" : "Norwegian"} ${e.included} in use, ${e.excluded} left out`).join("; ")}.`);
    if (m.hasProposed) out.push("- A learned card is waiting for review. It stays waiting.");
    if (m.learnRunning) out.push(`- A learn is marked as running. ${mode === "applied" ? "It was" : "It would be"} marked interrupted and is not restarted.`);
    if (m.modelOverrides.length > 0) out.push("- Its card names its own model choices. They are kept on the card; today only the shared default card's model choices are used.");
    for (const v of m.voices) out.push(`- ${v.line}`);
  }
  if (plan.running.length > 0 && plan.learnRecentlyActive) {
    out.push("");
    out.push("An agent's voice-learning schedule checked in during the last five minutes. It does that every minute while the agent " +
      "runs, so a learn marked as running may really be in progress, or may be left over from a learn that was cut off (for " +
      "example by a restart). Marking it interrupted is safe either way: a learn that is really in progress writes its own " +
      "status again when it finishes or fails.");
  }
  const defaultRunning = plan.running.includes("default");
  if (defaultRunning) {
    out.push("");
    out.push(`- The shared default card has a learn marked as running. ${mode === "applied" ? "It was" : "It would be"} marked interrupted and is not restarted.`);
  }
  const held = plan.mailboxes.filter((m) => m.decision.kind === "held").length;
  out.push("");
  out.push("## Summary");
  out.push(`- ${s(plan.mailboxes.filter((m) => m.decision.kind === "linked").length, "mailbox", "mailboxes")} linked or to be linked, ${held} held, ${s(plan.mailboxes.filter((m) => m.decision.kind === "conflict").length, "problem")}.`);
  if (held > 0) out.push("- A held mailbox keeps working exactly as today. It can be linked later with --map <mailbox>=<account id>.");
  out.push("- Running this again is safe: it only links what is not linked yet.");
  if (plan.blocking.length > 0) {
    out.push("");
    out.push("## Stops --apply");
    for (const b of plan.blocking) out.push(`- ${b}`);
  }
  out.push("");
  return out.join("\n");
}
