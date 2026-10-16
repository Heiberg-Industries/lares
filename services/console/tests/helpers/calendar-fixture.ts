import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

/**
 * The statutory calendar is installation data (DEADLINE_CALENDAR_FILE). This is a made-up one for
 * the tests: twelve rules for a made-up jurisdiction, six of them a "vat-*" set that some
 * companies do not have.
 */
const r = (key: string, title: string, month: number, day: number, yearOffset: 0 | 1, consequence = "A late fee runs per day.") => ({
  key, title, month, day, yearOffset, recurrence: "yearly", consequence, evidenceRule: "owner confirms",
});

export const TEST_CALENDAR = {
  jurisdiction: "XX-CO",
  rules: [
    r("register-return", "Register return", 1, 31, 1),
    r("vat-t6", "VAT return, term 6", 2, 10, 1),
    r("advance-tax-1", "Advance tax, term 1", 2, 15, 1, "Interest runs and collection starts."),
    r("vat-t1", "VAT return, term 1", 4, 10, 0),
    r("advance-tax-2", "Advance tax, term 2", 4, 15, 1, "Interest runs and collection starts."),
    r("tax-return", "Company tax return", 5, 31, 1, "A fine and possible extra tax."),
    r("vat-t2", "VAT return, term 2", 6, 10, 0),
    r("annual-meeting", "Annual general meeting", 6, 30, 1, "The accounts cannot be approved."),
    r("annual-accounts", "Annual accounts", 7, 31, 1, "A late fee; forced closure if it persists."),
    r("vat-t3", "VAT return, term 3", 8, 31, 0),
    r("vat-t4", "VAT return, term 4", 10, 10, 0),
    r("vat-t5", "VAT return, term 5", 12, 10, 0),
  ],
};

/** Write TEST_CALENDAR to a temp file and point DEADLINE_CALENDAR_FILE at it for the file's tests. */
export function useTestCalendar(): void {
  let dir: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "deadline-calendar-"));
    const file = join(dir, "calendar.json");
    writeFileSync(file, JSON.stringify(TEST_CALENDAR));
    process.env["DEADLINE_CALENDAR_FILE"] = file;
  });
  afterAll(() => {
    delete process.env["DEADLINE_CALENDAR_FILE"];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
}
