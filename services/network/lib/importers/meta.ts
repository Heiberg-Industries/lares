import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { upsertContact, findContactByIdentity, type IdentityKind } from "../resolve.js";
import { normalizeName } from "../normalize.js";

export type MetaSummary = {
  instagram: { threads: number; messages: number };
  facebook: { threads: number; messages: number };
  newContacts: number;
  linkedExisting: number;
  handles: { stored: number; linkedToContacts: number };
};

/** Bot/placeholder counterparties that are never real people. */
const SKIP_NAMES = new Set(["Meta AI", "Facebook user"]);

/**
 * Meta exports are double-encoded UTF-8. Round-tripping latin1→utf8 repairs it;
 * pure ASCII is unchanged. If the round-trip produces the replacement char the
 * text was already correct, so keep the original.
 */
export function fixMojibake(s: string): string {
  try {
    const fixed = Buffer.from(s, "latin1").toString("utf8");
    return fixed.includes("�") ? s : fixed;
  } catch {
    return s;
  }
}

/** Both export shapes → a flat list of repaired participant names. */
export function participantNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const p of raw) {
    const name = typeof p === "string" ? p : p && typeof p === "object" ? (p as { name?: unknown }).name : null;
    if (typeof name === "string" && name) out.push(fixMojibake(name));
  }
  return out;
}

/** `inbox/<username>_<threadid>` → `<username>` (lowercased). */
export function igUsername(threadPath: string | undefined): string | null {
  if (!threadPath) return null;
  const base = threadPath.split("/").filter(Boolean).pop() ?? "";
  const idx = base.lastIndexOf("_");
  if (idx <= 0) return null;
  return base.slice(0, idx).toLowerCase();
}

function externalId(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

/** The one hashed export subdir under root/<sub>, or null if absent. */
function exportBaseDir(root: string, sub: string): string | null {
  const base = join(root, sub);
  if (!existsSync(base)) return null;
  for (const entry of readdirSync(base)) {
    try {
      if (statSync(join(base, entry)).isDirectory()) return join(base, entry);
    } catch {
      /* skip unreadable entries */
    }
  }
  return null;
}

/** All message_*.json files under an inbox dir (handles paginated threads). */
function threadFiles(inboxDir: string | null): string[] {
  if (!inboxDir || !existsSync(inboxDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(inboxDir)) {
    const dir = join(inboxDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(dir)) {
      if (f.startsWith("message_") && f.endsWith(".json")) out.push(join(dir, f));
    }
  }
  return out;
}

type HandleRow = { handle: string | null; name: string | null; ts: number | null };

/** Read a Meta "string_list" file: either a top-level array or `{ <key>: [...] }`. */
function readListItems(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(d)) return d as Record<string, unknown>[];
    if (d && typeof d === "object") {
      const first = Object.values(d as Record<string, unknown>).find((v) => Array.isArray(v));
      return Array.isArray(first) ? (first as Record<string, unknown>[]) : [];
    }
  } catch {
    /* fall through */
  }
  return [];
}

/** Last non-`_u` path segment of an href, e.g. ".../twistedmind" → "twistedmind". */
function handleFromHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const seg = href.split("/").filter((s) => s && s !== "_u").pop();
  return seg ? seg.toLowerCase() : null;
}

/**
 * Per-relation extraction:
 *  - friend: name only (`item.name`), no handle.
 *  - following: `item.title` IS the handle, no real name.
 *  - follower / threads_*: handle from string_list_data.value (or href), name from title (may be empty).
 */
function extractHandleRow(item: Record<string, unknown>, relation: string): HandleRow {
  if (relation === "friend") {
    const name = typeof item.name === "string" ? fixMojibake(item.name) : null;
    const ts = typeof item.timestamp === "number" ? item.timestamp : null;
    return { handle: null, name, ts };
  }
  const sld = Array.isArray(item.string_list_data) ? (item.string_list_data[0] as Record<string, unknown> | undefined) : undefined;
  const ts = sld && typeof sld.timestamp === "number" ? (sld.timestamp as number) : null;
  if (relation === "following") {
    const handle = typeof item.title === "string" && item.title ? item.title.toLowerCase() : handleFromHref(sld?.href);
    return { handle, name: null, ts };
  }
  const handle = (typeof sld?.value === "string" && sld.value ? sld.value.toLowerCase() : null) ?? handleFromHref(sld?.href);
  const title = typeof item.title === "string" && item.title ? fixMojibake(item.title) : null;
  return { handle, name: title, ts };
}

/**
 * Two message schemas share this shape. The Facebook/Instagram DYI exports use
 * `sender_name` / `timestamp_ms` / `content`; the encrypted Messenger
 * secure-storage export uses `senderName` / `timestamp` / `text` (timestamp also
 * in milliseconds). Both timestamps are ms.
 */
type RawMessage = {
  sender_name?: unknown;
  senderName?: unknown;
  timestamp_ms?: unknown;
  timestamp?: unknown;
  content?: unknown;
  text?: unknown;
};

type ThreadJson = {
  participants?: unknown;
  messages?: RawMessage[];
  thread_path?: string;
};

/**
 * Normalize a message from either schema to `{ sender, text, ts }`, or null when
 * there's no text body / usable timestamp (attachment / media / placeholder /
 * call-event rows). `ts` is milliseconds in both schemas.
 */
function readMessage(m: RawMessage): { sender: string; text: string; ts: number } | null {
  const text = typeof m.content === "string" ? m.content : typeof m.text === "string" ? m.text : null;
  if (!text) return null;
  const ts = typeof m.timestamp_ms === "number" ? m.timestamp_ms : typeof m.timestamp === "number" ? m.timestamp : null;
  if (ts === null) return null;
  const sender = typeof m.sender_name === "string" ? m.sender_name : typeof m.senderName === "string" ? m.senderName : "";
  return { sender, text, ts };
}

function attachIdentity(db: Db, contactId: number, kind: IdentityKind, value: string, source: string): void {
  db.prepare("INSERT OR IGNORE INTO identities (contact_id, kind, value, source) VALUES (?, ?, ?, ?)").run(
    contactId,
    kind,
    value,
    source,
  );
}

export function importMeta(db: Db, exportRoot: string, ownName: string): MetaSummary {
  // Repair any double-encoded diacritics in the caller-supplied name once, so
  // counterparty and direction checks compare apples-to-apples with the
  // participant names that have already been run through fixMojibake.
  const own = fixMojibake(ownName);

  const summary: MetaSummary = {
    instagram: { threads: 0, messages: 0 },
    facebook: { threads: 0, messages: 0 },
    newContacts: 0,
    linkedExisting: 0,
    handles: { stored: 0, linkedToContacts: 0 },
  };

  // Snapshot of existing names BEFORE this import — unique-name link matches only
  // against these, never against contacts created during the run, so two distinct
  // Meta people who share a name never collapse into one.
  const nameSnapshot = new Map<string, number[]>();
  for (const c of db.prepare("SELECT id, display_name FROM contacts").all() as { id: number; display_name: string }[]) {
    const k = normalizeName(c.display_name);
    const list = nameSnapshot.get(k);
    if (list) list.push(c.id);
    else nameSnapshot.set(k, [c.id]);
  }

  const igBase = exportBaseDir(exportRoot, "instagram");
  const fbBase = exportBaseDir(exportRoot, "facebook");
  const igInbox = igBase ? join(igBase, "your_instagram_activity", "messages", "inbox") : null;
  const fbInbox = fbBase ? join(fbBase, "your_facebook_activity", "messages", "inbox") : null;
  const messengerDir = join(exportRoot, "messenger", "messages");
  // Encrypted Messenger export stores one flat <Name>_<N>.json per thread (no per-thread
  // subdirectory), unlike the IG/FB inbox/<thread>/message_*.json shape — hence enumerated here directly.
  const messengerFiles =
    existsSync(messengerDir) ? readdirSync(messengerDir).filter((f) => f.endsWith(".json")).map((f) => join(messengerDir, f)) : [];

  const ins = db.prepare(
    "INSERT OR IGNORE INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const contactCache = new Map<string, number>();
  const igThreadKeys = new Set<string>();
  const fbThreadKeys = new Set<string>();

  const resolveContact = (channel: "instagram" | "facebook", name: string, username: string | null): number => {
    const normalizedName = normalizeName(name);
    const cacheKey = `${channel}:${username ?? normalizedName}`;
    const cached = contactCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let id: number | null = null;
    if (username) {
      id = findContactByIdentity(db, "instagram", username);
      if (id !== null) attachIdentity(db, id, "instagram", username, channel);
    } else {
      id = findContactByIdentity(db, "meta_name", normalizedName);
    }
    if (id === null) {
      const matches = nameSnapshot.get(normalizedName);
      if (matches && matches.length === 1) {
        id = matches[0];
        if (username) attachIdentity(db, id, "instagram", username, channel);
        else attachIdentity(db, id, "meta_name", normalizedName, channel);
        summary.linkedExisting++;
      }
    }
    if (id === null) {
      id = upsertContact(db, { displayName: name, source: channel, identities: [], resolved: false });
      if (username) attachIdentity(db, id, "instagram", username, channel);
      else attachIdentity(db, id, "meta_name", normalizedName, channel);
      summary.newContacts++;
    }
    contactCache.set(cacheKey, id);
    return id;
  };

  const processThread = (path: string, channel: "instagram" | "facebook"): void => {
    let data: ThreadJson;
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as ThreadJson;
    } catch {
      return; // unreadable/garbled file — skip rather than abort the whole import
    }
    const names = participantNames(data.participants);
    if (names.length !== 2) return; // not a 1:1 thread
    const counterparty = names.find((n) => n !== own);
    if (!counterparty || SKIP_NAMES.has(counterparty)) return;

    // Keep only messages with a text body and a usable timestamp (handles both
    // export schemas). An attachment/media/placeholder row with no text, or an
    // entirely empty thread, contributes nothing — and must NOT create a
    // contactless junk contact.
    const textMessages = (data.messages ?? []).map(readMessage).filter((m): m is { sender: string; text: string; ts: number } => m !== null);
    if (textMessages.length === 0) return;

    const username = channel === "instagram" ? igUsername(data.thread_path) : null;
    const threadKey = username ?? normalizeName(counterparty);
    const contactId = resolveContact(channel, counterparty, username);
    if (channel === "instagram") igThreadKeys.add(threadKey);
    else fbThreadKeys.add(threadKey);

    for (const m of textMessages) {
      const content = fixMojibake(m.text);
      const sender = m.sender ? fixMojibake(m.sender) : "";
      const direction = sender === own ? "outbound" : "inbound";
      // ts is milliseconds in both schemas (very old archives could theoretically
      // store seconds; not handled — current exports are ms).
      const at = new Date(m.ts).toISOString();
      const eid = externalId([threadKey, String(m.ts), content.slice(0, 64)]);
      const changes = ins.run(contactId, channel, direction, at, content, eid).changes;
      if (channel === "instagram") summary.instagram.messages += changes;
      else summary.facebook.messages += changes;
    }
  };

  const tx = db.transaction(() => {
    for (const f of threadFiles(igInbox)) processThread(f, "instagram");
    for (const f of threadFiles(fbInbox)) processThread(f, "facebook");
    for (const f of messengerFiles) processThread(f, "facebook");
  });
  tx();

  summary.instagram.threads = igThreadKeys.size;
  summary.facebook.threads = fbThreadKeys.size;

  // --- handle directory ---
  const insHandle = db.prepare(
    "INSERT OR IGNORE INTO handles (platform, handle, display_name, relation, contact_id, observed_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const handleSources: { path: string | null; platform: string; relation: string }[] = [
    { path: igBase ? join(igBase, "connections", "followers_and_following", "following.json") : null, platform: "instagram", relation: "following" },
    { path: igBase ? join(igBase, "connections", "followers_and_following", "followers_1.json") : null, platform: "instagram", relation: "follower" },
    { path: igBase ? join(igBase, "your_instagram_activity", "threads", "following.json") : null, platform: "instagram", relation: "threads_following" },
    { path: igBase ? join(igBase, "your_instagram_activity", "threads", "followers.json") : null, platform: "instagram", relation: "threads_follower" },
    { path: fbBase ? join(fbBase, "connections", "friends", "your_friends.json") : null, platform: "facebook", relation: "friend" },
  ];

  const dirTx = db.transaction(() => {
    for (const src of handleSources) {
      if (!src.path) continue;
      for (const item of readListItems(src.path)) {
        const { handle, name, ts } = extractHandleRow(item, src.relation);
        if (!handle && !name) continue;
        const observedAt = ts !== null ? new Date(ts * 1000).toISOString() : "1970-01-01T00:00:00.000Z";

        let contactId: number | null = null;
        if (handle && name) {
          const matches = nameSnapshot.get(normalizeName(name));
          if (matches && matches.length === 1) {
            contactId = matches[0];
            attachIdentity(db, contactId, "instagram", handle, src.platform);
            summary.handles.linkedToContacts++;
          }
        }
        const changes = insHandle.run(src.platform, handle, name, src.relation, contactId, observedAt).changes;
        summary.handles.stored += changes;
      }
    }
  });
  dirTx();

  return summary;
}
