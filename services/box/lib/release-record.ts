/**
 * The release file and the release notes of a test release, written from what a publishing run
 * actually produced. Everything here is a fact read from the run; the parts that need a person
 * (what changed in words, what breaks) are filled with a marker that the tests refuse to merge.
 *
 * Pure: no git, no files. bin/write-release-record.ts feeds it.
 */
import type { ReleaseManifest } from "./release-manifest.js";
import type { PlanRow } from "./release-plan.js";

/** The words that mark a part nobody has written yet. A release record or notes file holding them cannot merge. */
export const UNWRITTEN_MARKER = "TO BE WRITTEN BY A PERSON";

export const RELEASE_NAME = /^\d{4}-\d{2}-\d{2}-rc\.\d+(\.test\.\d+)?$/;

export class RecordInvalid extends Error {}

/** `2026-11-20-rc.15.test.7` -> `rc.15.test.7`: the name the notes file carries. */
export function shortName(release: string): string {
  if (!RELEASE_NAME.test(release)) throw new RecordInvalid(`"${release}" is not a release name like 2026-11-20-rc.15.test.7`);
  return release.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

export interface RecordFacts {
  readonly release: string;
  readonly head: string;
  readonly previous: ReleaseManifest;
  readonly rows: readonly PlanRow[];
  readonly images: Readonly<Record<string, string>>;
  readonly sources: Readonly<Record<string, string>>;
  readonly migrations: { readonly box: string; readonly chiefOfStaff?: string };
  /** `critical` / `high` counts per image key, from the scan of this run; absent when this run scanned nothing for it. */
  readonly scans: Readonly<Record<string, { readonly critical: number; readonly high: number }>>;
  /** Jobs of the run: name and conclusion. */
  readonly jobs: readonly { readonly name: string; readonly conclusion: string }[];
  readonly runUrl: string;
  /** Subject lines of the commits between the previous release and this one; null when that could not be worked out. */
  readonly changes: readonly string[] | null;
  readonly changesBase: string | null;
  readonly today: string;
}

/** The release file, as the text to write. Keys in the order the earlier files have them, then `sources`. */
export function releaseFileText(facts: RecordFacts): string {
  const order = ["db", "console", "lares-gateway", "caddy", "lares-keeper", "lares-egress-proxy", "lares-firewall-helper", "chief-of-staff", "creative", "sync-jobs"];
  const images: Record<string, string> = {};
  for (const key of [...order, ...Object.keys(facts.images).filter((key) => !order.includes(key))]) {
    if (facts.images[key] !== undefined) images[key] = facts.images[key]!;
  }
  const sources: Record<string, string> = {};
  for (const key of Object.keys(images)) if (facts.sources[key] !== undefined) sources[key] = facts.sources[key]!;
  const file = {
    release: facts.release,
    images,
    sources,
    migrations: facts.migrations,
    breaking: [`${UNWRITTEN_MARKER}: replace this line with one sentence for each change an operator updating from the previous release must know, or delete it if there is none.`],
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const label = (key: string): string => ({
  console: "console",
  "lares-keeper": "keeper",
  "lares-egress-proxy": "egress proxy",
  "lares-firewall-helper": "firewall helper",
  "chief-of-staff": "chief-of-staff runtime",
  creative: "creative runtime",
  "sync-jobs": "sync jobs",
}[key] ?? key);

export function releaseNotesText(facts: RecordFacts): string {
  const short = shortName(facts.release);
  const built = facts.rows.filter((row) => row.action === "build");
  const carried = facts.rows.filter((row) => row.action === "carry");
  const lines: string[] = [];
  const add = (...more: string[]): void => { lines.push(...more); };

  add(
    `# ${short} release notes`,
    "",
    `**This is a test release, not a finished release.** Do not use it for an installation you depend on. Its record is \`releases/${facts.release}.json\`. The name deliberately differs from the usual date, \`rc.\` and number, so that nobody following the install guide picks it by accident.`,
    "",
    "## What it is built from",
    "",
    `The images listed as built below were built from commit \`${facts.head}\`, by the publishing run ${facts.runUrl === "" ? "(address not recorded)" : facts.runUrl}, on ${facts.today}.`,
    "",
    `The previous release is ${facts.previous.release}.`,
    "",
    "### Images built and images carried over",
    "",
    "A carried-over image keeps the digest of the previous release and the commit that release recorded for it. It is never described as built from this release's commit.",
    "",
    "| Image | This release | Built from | Why |",
    "|---|---|---|---|",
  );
  const cell = (text: string): string => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  for (const row of facts.rows) {
    add(`| ${label(row.key)} | ${row.action === "build" ? "built in this run" : "carried over"} | \`${facts.sources[row.key] ?? "unknown"}\` | ${cell(row.reason)} |`);
  }
  add(
    "",
    `The database image, the gateway image (the upstream LiteLLM image) and the proxy in front of the console (Caddy) are not built by this project. They are copied unchanged from the ${facts.previous.release} record; nothing in this run checked whether newer ones exist.`,
    "",
    `In total ${built.length} image${built.length === 1 ? " was" : "s were"} built and ${carried.length} carried over.`,
    "",
    "## Changes since the previous release",
    "",
  );
  if (facts.changes === null) {
    add("The previous release record names no source commit for its images, so the list of changes between the two releases was not worked out here. Compare by hand.");
  } else if (facts.changes.length === 0) {
    add(`No commit lies between ${facts.changesBase} and ${facts.head}.`);
  } else {
    add(`Commit titles from ${facts.changesBase} to ${facts.head}, newest first:`, "", ...facts.changes.map((change) => `- ${change}`));
  }
  add(
    "",
    "## What changed, and what breaks",
    "",
    `${UNWRITTEN_MARKER}. Replace this paragraph with what changed in plain words, one short paragraph or bullet for each change a person using the release would notice. Then write each breaking change as one sentence in the \`breaking\` list of the release file, or delete the placeholder line if nothing breaks. The tests refuse to pass while this marker is still in a release file or in these notes.`,
    "",
    "## Security scan",
    "",
    "Scanner: Trivy, no ignore list, run by CI against each final linux/amd64 image immediately before it was published (the number of the version is in the scan step's output). The published digests were not scanned a second time. High and critical findings of the images built in this run:",
    "",
    "| Image | Critical | High |",
    "|---|---|---|",
  );
  for (const row of built) {
    const scan = facts.scans[row.key];
    add(scan === undefined ? `| ${label(row.key)} | not reported by this run | not reported by this run |` : `| ${label(row.key)} | ${scan.critical} | ${scan.high} |`);
  }
  add(
    "",
    `A carried-over image was scanned when it was built, for ${facts.previous.release}; this run did not scan it again, and reuse does not clear it.`,
    "",
    "## What the automated run tested",
    "",
    "These jobs of the publishing run finished, in this order of name:",
    "",
    ...(facts.jobs.length === 0
      ? ["The list of jobs could not be read when this file was written."]
      : [...facts.jobs].sort((a, b) => a.name.localeCompare(b.name)).map((job) => `- ${job.name}: ${job.conclusion}`)),
    "",
    "The automated run does not replace trying the release on a test server: nothing above says that a live conversation, a live approval or an update with a conversation open works. Add here what a person has tried.",
    "",
  );
  return lines.join("\n");
}

/** Counts critical and high findings in a Trivy JSON report. Throws on a report it cannot read. */
export function countFindings(reportText: string): { critical: number; high: number } {
  const report = JSON.parse(reportText) as { Results?: { Vulnerabilities?: { Severity?: string }[] | null }[] };
  if (typeof report !== "object" || report === null) throw new RecordInvalid("a scan report is not a JSON object");
  let critical = 0;
  let high = 0;
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      if (vulnerability.Severity === "CRITICAL") critical += 1;
      else if (vulnerability.Severity === "HIGH") high += 1;
    }
  }
  return { critical, high };
}
