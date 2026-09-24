import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../lib/db.js";
import { importContacts } from "../lib/importers/contacts.js";

let db: Db;
const dirs: string[] = [];
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeAddressBookFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "abook-"));
  dirs.push(root);
  const srcDir = join(root, "Sources", "ABCD-1234");
  mkdirSync(srcDir, { recursive: true });
  const ab = new Database(join(srcDir, "AddressBook-v22.abcddb"));
  ab.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZADDRESS TEXT, ZOWNER INTEGER);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZFULLNUMBER TEXT, ZOWNER INTEGER);
  `);
  ab.prepare("INSERT INTO ZABCDRECORD VALUES (1, 'Peter', 'Karlsson', 'Curamando')").run();
  ab.prepare("INSERT INTO ZABCDEMAILADDRESS VALUES (1, 'Peter@Example.se', 1)").run();
  ab.prepare("INSERT INTO ZABCDPHONENUMBER VALUES (1, '+46 70 123 45 67', 1)").run();
  ab.prepare("INSERT INTO ZABCDRECORD VALUES (2, NULL, NULL, 'Pizzabakeren')").run(); // org-only card
  ab.prepare("INSERT INTO ZABCDPHONENUMBER VALUES (2, '982 12 345', 2)").run();
  ab.prepare("INSERT INTO ZABCDRECORD VALUES (3, 'Empty', 'Card', NULL)").run(); // no identities → skipped
  ab.close();
  return root;
}

describe("importContacts", () => {
  it("imports people with normalized emails and phones", () => {
    const summary = importContacts(db, makeAddressBookFixture());
    expect(summary.contacts).toBe(2); // Empty Card skipped
    const peter = db.prepare("SELECT id, company FROM contacts WHERE display_name = 'Peter Karlsson'").get() as any;
    expect(peter.company).toBe("Curamando");
    const ids = db.prepare("SELECT kind, value FROM identities WHERE contact_id = ? ORDER BY kind").all(peter.id);
    expect(ids).toEqual([
      { kind: "email", value: "peter@example.se" },
      { kind: "phone", value: "+46701234567" },
    ]);
  });

  it("uses organization as display name when person has no name", () => {
    importContacts(db, makeAddressBookFixture());
    const org = db.prepare("SELECT display_name FROM contacts WHERE company = 'Pizzabakeren'").get() as any;
    expect(org.display_name).toBe("Pizzabakeren");
  });

  it("is idempotent", () => {
    const fixture = makeAddressBookFixture();
    importContacts(db, fixture);
    const before = db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as any;
    importContacts(db, fixture);
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts").get()).toEqual(before);
  });
});
