import { parse } from "csv-parse/sync";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { upsertContact } from "../resolve.js";
import { normalizeEmail, normalizeLinkedInUrl } from "../normalize.js";

export type LinkedInSummary = { connections: number; messages: number; invitations: number; signals: number };

/** Strip LinkedIn's "Notes:" preamble: keep from the first line that starts with the real header. */
function stripPreamble(raw: string, headerStart: string): string {
  const idx = raw.indexOf(headerStart);
  if (idx === -1) throw new Error(`Could not find header "${headerStart}" — is this a LinkedIn export?`);
  return raw.slice(idx);
}

function readCsv(path: string, headerStart?: string): Record<string, string>[] {
  let raw = readFileSync(path, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM
  if (headerStart) raw = stripPreamble(raw, headerStart);
  return parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
}

function parseConnectedOn(v: string): string {
  // "03 Jun 2026"
  const d = new Date(v + " 12:00:00 UTC");
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function parseMessageDate(v: string): string | null {
  // "2026-06-07 12:45:24 UTC"
  const d = new Date(v.replace(" UTC", "Z").replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseInvitationDate(v: string): string | null {
  // "4/24/26, 10:52 AM" — US month/day, 2-digit year
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[4], 10) % 12;
  if (m[6].toUpperCase() === "PM") h += 12;
  const d = new Date(Date.UTC(2000 + parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10), h, parseInt(m[5], 10)));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function externalId(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

export function importLinkedIn(db: Db, exportDir: string, ownProfileUrl: string): LinkedInSummary {
  const own = normalizeLinkedInUrl(ownProfileUrl);
  if (!own) throw new Error(`Invalid own profile URL: ${ownProfileUrl}`);
  const summary: LinkedInSummary = { connections: 0, messages: 0, invitations: 0, signals: 0 };
  const urlToContact = new Map<string, number>();
  const insInteraction = db.prepare(
    "INSERT OR IGNORE INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (?, 'linkedin', ?, ?, ?, ?)",
  );
  const insInvitation = db.prepare(
    "INSERT OR IGNORE INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (?, 'linkedin_invite', ?, ?, ?, ?)",
  );

  const findByUrl = (url: string): number | null => {
    const cached = urlToContact.get(url);
    if (cached !== undefined) return cached;
    const r = db.prepare("SELECT contact_id FROM identities WHERE kind = 'linkedin_url' AND value = ?").get(url) as
      | { contact_id: number }
      | undefined;
    if (r) urlToContact.set(url, r.contact_id);
    return r ? r.contact_id : null;
  };
  const contactFor = (url: string | null): number | null => (url ? findByUrl(url) : null);

  const tx = db.transaction(() => {
    // --- Connections.csv ---
    const connectionsPath = join(exportDir, "Connections.csv");
    if (existsSync(connectionsPath)) {
      const now = new Date().toISOString();
      for (const row of readCsv(connectionsPath, "First Name,")) {
        const url = normalizeLinkedInUrl(row["URL"] ?? "");
        if (!url) continue;
        const name = `${row["First Name"] ?? ""} ${row["Last Name"] ?? ""}`.trim();
        if (!name) continue;
        const email = normalizeEmail(row["Email Address"] ?? "");
        const company = (row["Company"] ?? "").trim() || null;
        const title = (row["Position"] ?? "").trim() || null;

        // job-change detection BEFORE upsert (upsert only enriches blanks via COALESCE, never overwrites)
        const existing = db
          .prepare("SELECT c.id, c.company, c.title FROM contacts c JOIN identities i ON i.contact_id = c.id WHERE i.kind = 'linkedin_url' AND i.value = ?")
          .get(url) as { id: number; company: string | null; title: string | null } | undefined;
        if (existing && company && existing.company && existing.company !== company) {
          db.prepare("INSERT INTO signals (contact_id, kind, at, evidence) VALUES (?, 'job_change', ?, ?)").run(
            existing.id, now, JSON.stringify({ from: existing.company, to: company }),
          );
          db.prepare("UPDATE contacts SET company = ?, title = ? WHERE id = ?").run(company, title, existing.id);
          summary.signals++;
        } else if (existing && company && existing.company === company && title && existing.title && existing.title !== title) {
          db.prepare("INSERT INTO signals (contact_id, kind, at, evidence) VALUES (?, 'promotion', ?, ?)").run(
            existing.id, now, JSON.stringify({ company, from: existing.title, to: title }),
          );
          db.prepare("UPDATE contacts SET title = ? WHERE id = ?").run(title, existing.id);
          summary.signals++;
        }

        const identities: { kind: "email" | "linkedin_url"; value: string }[] = [{ kind: "linkedin_url", value: url }];
        if (email) identities.push({ kind: "email", value: email });
        const id = upsertContact(db, { displayName: name, company, title, source: "linkedin", identities });
        urlToContact.set(url, id);
        if (company) {
          db.prepare("INSERT OR IGNORE INTO positions (contact_id, company, title, observed_at) VALUES (?, ?, ?, ?)").run(
            id, company, title, parseConnectedOn(row["Connected On"] ?? ""),
          );
        }
        summary.connections++;
      }
    }

    // --- messages.csv ---
    const messagesPath = join(exportDir, "messages.csv");
    if (existsSync(messagesPath)) {
      for (const row of readCsv(messagesPath)) {
        const at = parseMessageDate(row["DATE"] ?? "");
        if (!at) continue;
        const sender = normalizeLinkedInUrl(row["SENDER PROFILE URL"] ?? "");
        const outbound = sender === own;
        // the counterparty: sender if inbound, else first recipient
        const otherUrl = outbound
          ? normalizeLinkedInUrl((row["RECIPIENT PROFILE URLS"] ?? "").split(";")[0] ?? "")
          : sender;
        const contactId = contactFor(otherUrl);
        if (contactId === null) continue; // group threads / non-connections: skip in Phase 1
        summary.messages += insInteraction.run(
          contactId,
          outbound ? "outbound" : "inbound",
          at,
          row["CONTENT"] ?? "",
          externalId([row["CONVERSATION ID"] ?? "", at, (row["CONTENT"] ?? "").slice(0, 64)]),
        ).changes;
      }
    }

    // --- Invitations.csv ---
    const invitationsPath = join(exportDir, "Invitations.csv");
    if (existsSync(invitationsPath)) {
      for (const row of readCsv(invitationsPath)) {
        const at = parseInvitationDate(row["Sent At"] ?? "");
        if (!at) continue;
        const outbound = (row["Direction"] ?? "").toUpperCase() === "OUTGOING";
        const otherUrl = normalizeLinkedInUrl(outbound ? row["inviteeProfileUrl"] ?? "" : row["inviterProfileUrl"] ?? "");
        const contactId = contactFor(otherUrl);
        if (contactId === null) continue;
        const inviteId = externalId(["invite", row["inviterProfileUrl"] ?? "", row["inviteeProfileUrl"] ?? "", at]);
        // Phase 1 stored invitations under channel 'linkedin'; the v2 migration
        // only rechanneled the content-less ones. Remove any legacy twin so a
        // re-import can't double-record the same invitation.
        db.prepare("DELETE FROM interactions WHERE channel = 'linkedin' AND external_id = ?").run(inviteId);
        summary.invitations += insInvitation.run(
          contactId,
          outbound ? "outbound" : "inbound",
          at,
          (row["Message"] ?? "") || null,
          inviteId,
        ).changes;
      }
    }
  });
  tx();
  return summary;
}
