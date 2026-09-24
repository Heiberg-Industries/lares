import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Db } from "../db.js";
import { withSnapshot } from "../snapshot.js";
import { upsertContact } from "../resolve.js";
import { normalizeEmail, normalizePhone } from "../normalize.js";

export const DEFAULT_ADDRESSBOOK_ROOT = join(homedir(), "Library", "Application Support", "AddressBook");

export type ContactsSummary = { contacts: number; sources: number };

function findSourceDbs(root: string): string[] {
  const dbs: string[] = [];
  const rootDb = join(root, "AddressBook-v22.abcddb");
  if (existsSync(rootDb)) dbs.push(rootDb);
  const sources = join(root, "Sources");
  if (existsSync(sources)) {
    for (const entry of readdirSync(sources)) {
      const candidate = join(sources, entry, "AddressBook-v22.abcddb");
      if (existsSync(candidate)) dbs.push(candidate);
    }
  }
  if (dbs.length === 0) {
    throw new Error(
      `No AddressBook databases found under ${root}. ` +
        `Check Full Disk Access (System Settings → Privacy & Security → Full Disk Access).`,
    );
  }
  return dbs;
}

export function importContacts(db: Db, addressBookRoot: string = DEFAULT_ADDRESSBOOK_ROOT): ContactsSummary {
  const summary: ContactsSummary = { contacts: 0, sources: 0 };
  for (const sourceDb of findSourceDbs(addressBookRoot)) {
    summary.sources++;
    withSnapshot(sourceDb, (snap) => {
      const people = snap
        .prepare("SELECT Z_PK AS pk, ZFIRSTNAME AS first, ZLASTNAME AS last, ZORGANIZATION AS org FROM ZABCDRECORD")
        .all() as { pk: number; first: string | null; last: string | null; org: string | null }[];
      const emails = snap.prepare("SELECT ZADDRESS AS addr, ZOWNER AS owner FROM ZABCDEMAILADDRESS").all() as {
        addr: string | null;
        owner: number;
      }[];
      const phones = snap.prepare("SELECT ZFULLNUMBER AS num, ZOWNER AS owner FROM ZABCDPHONENUMBER").all() as {
        num: string | null;
        owner: number;
      }[];

      // NOTE: In real macOS Address Book databases, ZABCDRECORD may contain
      // non-person entity types (e.g. groups, distribution lists) alongside
      // person records — Core Data stores all entities in the same table,
      // distinguished by a Z_ENT column. The fixture only models person rows,
      // so Z_ENT filtering is intentionally omitted here. If real-world import
      // produces garbage contacts (e.g. group names appearing as people), add
      // a WHERE Z_ENT = <person_entity_id> filter — but validate against live
      // data in Task 13 first.
      const tx = db.transaction(() => {
        for (const p of people) {
          const name = [p.first, p.last].filter(Boolean).join(" ").trim() || (p.org ?? "").trim();
          if (!name) continue;
          const identities: { kind: "email" | "phone"; value: string }[] = [];
          for (const e of emails.filter((e) => e.owner === p.pk)) {
            const v = e.addr ? normalizeEmail(e.addr) : null;
            if (v) identities.push({ kind: "email", value: v });
          }
          for (const ph of phones.filter((ph) => ph.owner === p.pk)) {
            const v = ph.num ? normalizePhone(ph.num) : null;
            if (v) identities.push({ kind: "phone", value: v });
          }
          if (identities.length === 0) continue; // unreachable card: nothing to join on
          upsertContact(db, { displayName: name, company: p.org?.trim() || null, source: "contacts", identities });
          summary.contacts++;
        }
      });
      tx();
    });
  }
  return summary;
}
