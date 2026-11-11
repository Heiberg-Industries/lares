// The suggested model prices are only as good as the day somebody last read the providers' price
// pages. This fails when that day has fallen too far behind the newest release, so a release cannot
// go out carrying a price table nobody has looked at lately.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const PRICE_FILE = "services/box/ops/budget-commands.py";

/** The price check may be this many days older than the newest release, and no more. */
const MAX_DAYS_BEHIND = 14;
// Notes written before this rule existed are left as they were.
const NOTES_NAME_THE_DATE_FROM = "2026-11-12";
const WHAT_TO_DO = `check the providers' price pages, update the table and \`PRICES_CHECKED\` in ${PRICE_FILE}`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_MS = 86_400_000;

/** Midnight UTC of a calendar day, or null when there is no such day (31 November, month 13). */
function utcDay(year: number, month: number, day: number): number | null {
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day ? at.getTime() : null;
}

const plainDate = (at: number): string => {
  const date = new Date(at);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

/** The value of `PRICES_CHECKED = "..."` in the Python source, read as text. */
export function readPricesChecked(source: string): string | null {
  return /^PRICES_CHECKED\s*=\s*"([^"\n]*)"\s*$/m.exec(source)?.[1] ?? null;
}

/** "3 November 2026" as a day; null for anything else. */
export function parsePriceDate(text: string): number | null {
  const match = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(text);
  if (!match) return null;
  const month = MONTHS.indexOf(match[2]!) + 1;
  return month === 0 ? null : utcDay(Number(match[3]), month, Number(match[1]));
}

interface ReleaseRecord { file: string; name: string; isoDate: string; at: number }

/** `2026-11-10-rc.14.json` is release `rc.14` of 10 November 2026; null when the name carries no date. */
export function parseReleaseFile(file: string): ReleaseRecord | null {
  const match = /^((\d{4})-(\d{2})-(\d{2}))-(.+)\.json$/.exec(file);
  if (!match) return null;
  const at = utcDay(Number(match[2]), Number(match[3]), Number(match[4]));
  return at === null ? null : { file, name: match[5]!, isoDate: match[1]!, at };
}

export interface PriceTableFacts {
  /** The text of `PRICES_CHECKED`, or null when the constant is not there. */
  pricesChecked: string | null;
  /** The `.json` file names in `releases/`. */
  releaseFiles: readonly string[];
  /** The notes of a release by its name (`rc.14`), or null when it has no notes file. */
  notesFor: (releaseName: string) => string | null;
}

/** Every reason the price table is not fit to release, one plain sentence each. None means fresh. */
export function priceTableProblems({ pricesChecked, releaseFiles, notesFor }: PriceTableFacts): string[] {
  const problems: string[] = [];

  const checkedAt = pricesChecked === null ? null : parsePriceDate(pricesChecked);
  if (pricesChecked === null) {
    problems.push(`No \`PRICES_CHECKED = "..."\` line was found in ${PRICE_FILE}, so nobody can tell when the model prices were last checked: ${WHAT_TO_DO}.`);
  } else if (checkedAt === null) {
    problems.push(`\`PRICES_CHECKED\` in ${PRICE_FILE} is "${pricesChecked}", which is not a date written like "3 November 2026": ${WHAT_TO_DO}.`);
  }

  const records: ReleaseRecord[] = [];
  for (const file of releaseFiles) {
    const record = parseReleaseFile(file);
    if (record) records.push(record);
    else problems.push(`releases/${file} does not start with a date (YYYY-MM-DD), so it cannot be placed among the releases: name it like 2026-11-10-rc.14.json.`);
  }
  if (records.length === 0) {
    problems.push("There is no release record in releases/, so the age of the model price table cannot be judged against a release.");
    return problems;
  }
  if (pricesChecked === null || checkedAt === null) return problems;

  const newestAt = Math.max(...records.map((record) => record.at));
  // Several records can carry the newest date and nothing in a record orders them within a day, so
  // every one of them counts as the newest release.
  const newest = records.filter((record) => record.at === newestAt).sort((a, b) => a.file.localeCompare(b.file));

  if (Math.round((newestAt - checkedAt) / DAY_MS) > MAX_DAYS_BEHIND) {
    problems.push(
      `The model price table was last checked on ${plainDate(checkedAt)}, more than ${MAX_DAYS_BEHIND} days before the newest release on ` +
      `${plainDate(newestAt)} (releases/${newest.at(-1)!.file}): ${WHAT_TO_DO}.`,
    );
  }

  for (const record of newest) {
    if (record.isoDate < NOTES_NAME_THE_DATE_FROM) continue;
    const notesFile = `docs/releases/${record.name}-notes.md`;
    const notes = notesFor(record.name);
    if (notes === null) {
      problems.push(`releases/${record.file} has no notes file ${notesFile}: write it, and say in it that model prices were last checked on ${pricesChecked}.`);
    } else if (!notes.includes(pricesChecked)) {
      problems.push(`${notesFile} does not say when model prices were last checked: add a line with the \`PRICES_CHECKED\` date, "${pricesChecked}".`);
    }
  }
  return problems;
}

describe("the price table is fresh enough to release", () => {
  it("the price check date is no more than 14 days behind the newest release", () => {
    const problems = priceTableProblems({
      pricesChecked: readPricesChecked(readFileSync(join(root, PRICE_FILE), "utf8")),
      releaseFiles: readdirSync(join(root, "releases")).filter((file) => file.endsWith(".json")),
      notesFor: (name) => {
        const path = join(root, "docs", "releases", `${name}-notes.md`);
        return existsSync(path) ? readFileSync(path, "utf8") : null;
      },
    });
    expect(problems.join("\n")).toBe("");
  });
});

describe("priceTableProblems, with made-up dates", () => {
  const saysTheDate = () => "Model prices were last checked on 1 December 2026.";
  const facts = (over: Partial<PriceTableFacts>): PriceTableFacts => ({
    pricesChecked: "1 December 2026",
    releaseFiles: ["2026-11-20-rc.20.json", "2026-12-08-rc.21.json"],
    notesFor: saysTheDate,
    ...over,
  });

  it("passes a price check a week before the newest release", () => {
    expect(priceTableProblems(facts({}))).toEqual([]);
  });

  it("passes a price check made after the newest release", () => {
    expect(priceTableProblems(facts({ releaseFiles: ["2026-11-20-rc.20.json"] }))).toEqual([]);
  });

  it("passes at exactly 14 days", () => {
    expect(priceTableProblems(facts({ releaseFiles: ["2026-12-15-rc.22.json"] }))).toEqual([]);
  });

  it("fails at 15 days, naming both dates and what to do", () => {
    expect(priceTableProblems(facts({ releaseFiles: ["2026-11-20-rc.20.json", "2026-12-16-rc.22.json"] }))).toEqual([
      "The model price table was last checked on 1 December 2026, more than 14 days before the newest release on 16 December 2026 " +
      "(releases/2026-12-16-rc.22.json): check the providers' price pages, update the table and `PRICES_CHECKED` in services/box/ops/budget-commands.py.",
    ]);
  });

  it("counts days across a month end and a year end", () => {
    const yearEnd = { pricesChecked: "20 December 2026", notesFor: () => "last checked on 20 December 2026" };
    expect(priceTableProblems(facts({ ...yearEnd, releaseFiles: ["2027-01-03-rc.30.json"] }))).toEqual([]);
    expect(priceTableProblems(facts({ ...yearEnd, releaseFiles: ["2027-01-04-rc.30.json"] }))).toHaveLength(1);
  });

  it("orders releases by the date in the name, not by the name", () => {
    // By name alone rc.9 sorts after rc.30; by date it is the older one.
    expect(priceTableProblems(facts({ releaseFiles: ["2026-11-01-rc.9.json", "2026-12-08-rc.30.json"] }))).toEqual([]);
    expect(priceTableProblems(facts({ releaseFiles: ["2026-12-20-rc.9.json", "2026-12-08-rc.30.json"] }))[0]).toContain("20 December 2026");
  });

  it("fails when the price check date cannot be read as a date", () => {
    for (const pricesChecked of ["December 2026", "2026-12-01", "31 November 2026", "1 Decembre 2026", ""]) {
      const problems = priceTableProblems(facts({ pricesChecked }));
      expect(problems, pricesChecked).toHaveLength(1);
      expect(problems[0]).toContain(`is "${pricesChecked}", which is not a date`);
    }
  });

  it("fails when the constant is not in the file at all", () => {
    expect(readPricesChecked("PRICES = {}\n")).toBeNull();
    expect(priceTableProblems(facts({ pricesChecked: null }))).toEqual([expect.stringContaining("No `PRICES_CHECKED = \"...\"` line was found")]);
  });

  it("fails when there is no release record", () => {
    expect(priceTableProblems(facts({ releaseFiles: [] }))).toEqual([expect.stringContaining("There is no release record in releases/")]);
  });

  it("fails on a release record whose name carries no date", () => {
    for (const file of ["rc.23.json", "2026-13-01-rc.23.json", "2026-12-08.json"]) {
      const problems = priceTableProblems(facts({ releaseFiles: ["2026-12-08-rc.21.json", file] }));
      expect(problems, file).toEqual([expect.stringContaining(`releases/${file} does not start with a date`)]);
    }
  });

  it("fails when the newest release's notes do not carry the price check date", () => {
    expect(priceTableProblems(facts({ notesFor: () => "Model prices were checked recently." }))).toEqual([
      "docs/releases/rc.21-notes.md does not say when model prices were last checked: add a line with the `PRICES_CHECKED` date, \"1 December 2026\".",
    ]);
  });

  it("fails when the newest release has no notes file", () => {
    expect(priceTableProblems(facts({ notesFor: () => null }))).toEqual([
      expect.stringContaining("releases/2026-12-08-rc.21.json has no notes file docs/releases/rc.21-notes.md"),
    ]);
  });

  it("asks only the newest release's notes, and every record that shares its date", () => {
    const asked: string[] = [];
    const notesFor = (name: string) => { asked.push(name); return name === "rc.21.test.3" ? "nothing about prices" : saysTheDate(); };
    const problems = priceTableProblems(facts({ releaseFiles: ["2026-11-20-rc.20.json", "2026-12-08-rc.21.json", "2026-12-08-rc.21.test.3.json"], notesFor }));
    expect(asked).toEqual(["rc.21", "rc.21.test.3"]);
    expect(problems).toEqual([expect.stringContaining("docs/releases/rc.21.test.3-notes.md does not say")]);
  });

  it("leaves the notes of a release from before 12 November 2026 alone", () => {
    const before = { pricesChecked: "3 November 2026", notesFor: () => null };
    expect(priceTableProblems(facts({ ...before, releaseFiles: ["2026-11-11-rc.14.json"] }))).toEqual([]);
    expect(priceTableProblems(facts({ ...before, releaseFiles: ["2026-11-12-rc.15.json"] }))).toHaveLength(1);
  });

  it("reads the constant and the file name the way the real ones are written", () => {
    expect(readPricesChecked('# checked on the date below\nPRICES_CHECKED = "3 November 2026"\nSUGGESTED_PRICES = {}\n')).toBe("3 November 2026");
    expect(parsePriceDate("3 November 2026")).toBe(Date.UTC(2026, 10, 3));
    expect(parseReleaseFile("2026-11-10-rc.14.test.7.json")).toEqual({
      file: "2026-11-10-rc.14.test.7.json", name: "rc.14.test.7", isoDate: "2026-11-10", at: Date.UTC(2026, 10, 10),
    });
  });
});
