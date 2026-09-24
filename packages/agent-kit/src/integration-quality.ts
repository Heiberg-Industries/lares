// The entry tier, written down once (ADR-0019 decision 7, docs/specs/2026-08-31-lares-engine-
// overlay-inventory-design.md:133-168). A manifest's `quality` field (integration-manifest.ts)
// points at one of these files. The manifest can carry a tier CLAIM one day; this file is the
// EVIDENCE for that claim, rule by rule — keeping them apart is what makes "a claimed tier not
// backed by its rules fails the build" mean anything (checked by a later slice's `checkQuality`,
// not by the parser below).
//
// Owner ruling C1 (2026-09-19, wave 6 plan §6C): the three integrations ship at a new lowest
// tier, `none`, rather than each claiming `bronze` before every bronze rule is actually `done`.
// `none` costs nothing to satisfy — it is simply "no tier claimed yet" — and it keeps a
// `quality.yaml` honest while wave 6B closes out the remaining bronze `todo`s.
//
// Format (deliberately NOT full YAML — see the module's test file for why no parser dependency
// was added): a top-level `tier: <value>` line, then a `rules:` line, then one indented
// `<name>: done|todo|exempt` line per rule, an optional trailing `# comment` on any rule line.
// An `exempt` status REQUIRES a comment — the comment is the only place the exemption is stated,
// so a check that reads `exempt` without one has no idea what was excused or why.
//
// The checker below (`checkQuality`) is the enforcement half: a manifest's `quality.yaml` is
// never trusted at face value. A claimed tier that the file's own rules do not back — a bronze
// claim with a bronze rule still `todo`, a `tier: gold` claim (wave 6 defines no gold rules —
// owner decision C2) — is a finding, named down to the first unmet rule. The debt list
// (`INTEGRATIONS_WITHOUT_SCALE`) is the same ratchet as `KNOWN_UNDECLARED_SECRETS` and
// `KNOWN_MISSING_PROBES`: it may only shrink, and an entry that grows a quality file of its own
// must be removed from the list in the same change, never left to rot.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadIntegrationManifests } from "./integration-manifest.js";

/** The entry tier — Lares's existing six-point checklist, each point stated as something a test
 *  or a reviewer can answer yes/no to. Order is fixed: it is the order a quality.yaml lists. */
export const BRONZE_RULES = [
  "live-probe", // a committed tests/live/<api>.live.mts, named in the manifest
  "region-declared", // region on the manifest and on every adapter capability doc
  "outbound-declared", // every host in outbound_hosts, and nothing reaching one that is not
  "secrets-declared", // no /run/secrets/<name> the manifest does not name
  "no-telemetry", // no analytics, crash-reporting or usage-ping code path
  "contract-tests", // its tools pass against the neutral default agent.json
  "shared-request-path", // no hand-rolled fetch loop: the SDK or makeRequester
  "credential-tested", // the credential type has a `test` call (credential.ts's runCredentialTest)
] as const;

export const SILVER_RULES = [
  "reauth", // a dead token produces one sentence and a Repair, not a stack trace
  "named-owner", // codeowner is a real, current owner
  "log-once", // one line when it goes down, one when it comes back
  "approval-class", // every write capability declares its always-ask class
  "backoff-honoured", // Retry-After respected; the SDK's own retry and ours do not compound
  "probe-rerun", // the live probe was re-run for this release and the date recorded
] as const;

/** `none` is the fourth, lowest value (owner decision C1): claiming nothing yet is honest when
 *  bronze rules remain `todo`. `gold` carries no rules of its own in wave 6 (owner decision C2) —
 *  a later slice's checker refuses a `gold` claim outright, on purpose. */
export const TIERS = ["none", "bronze", "silver", "gold"] as const;
export type Tier = (typeof TIERS)[number];

export type RuleStatus = "done" | "todo" | { exempt: string };

export interface QualityFile {
  tier: Tier;
  rules: Record<string, RuleStatus>;
}

const TIER_RANK: Record<Tier, number> = { none: 0, bronze: 1, silver: 2, gold: 3 };

const RULE_RANK: Record<string, 1 | 2> = Object.fromEntries([
  ...BRONZE_RULES.map((r) => [r, 1] as const),
  ...SILVER_RULES.map((r) => [r, 2] as const),
]);

const RULE_LINE = /^\s+([A-Za-z0-9_-]+):\s*(done|todo|exempt)\s*(?:#\s*(.*?))?\s*$/;

/**
 * Parses the narrow, six/eight-key shape above — never a general YAML document. `id` names the
 * integration in every thrown message, so a failure in CI points straight at the file.
 */
export function parseQualityFile(text: string, id: string): QualityFile {
  let tier: Tier | undefined;
  const rules: Record<string, RuleStatus> = {};
  let inRulesBlock = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    if (!/^\s/.test(line)) {
      inRulesBlock = false;
      const tierMatch = /^tier:\s*(\S+)\s*$/.exec(trimmed);
      if (tierMatch) {
        const value = tierMatch[1];
        if (!(TIERS as readonly string[]).includes(value)) {
          throw new Error(
            `Quality file for "${id}" claims an unknown tier "${value}" — must be one of ${TIERS.join(", ")}`,
          );
        }
        tier = value as Tier;
        continue;
      }
      if (trimmed === "rules:" || trimmed === "rules: {}") {
        // "rules: {}" is the one flow-style exception this narrow reader accepts: an explicitly
        // empty rules block (used by a fixture that wants a file with a tier and no rules at all).
        inRulesBlock = true;
        continue;
      }
      throw new Error(`Quality file for "${id}" has a line it cannot parse: "${trimmed}"`);
    }

    if (!inRulesBlock) {
      throw new Error(`Quality file for "${id}" indents a line outside "rules:": "${trimmed}"`);
    }
    if (tier === undefined) {
      throw new Error(`Quality file for "${id}" lists rules before declaring a tier`);
    }

    const match = RULE_LINE.exec(line);
    if (!match) {
      throw new Error(`Quality file for "${id}" has a rule line it cannot parse: "${trimmed}"`);
    }
    const [, name, status, comment] = match;
    const ruleRank = RULE_RANK[name];
    if (ruleRank === undefined) {
      throw new Error(
        `Quality file for "${id}" names an unknown rule "${name}" — no rule by that name is defined`,
      );
    }
    const maxAllowedRuleRank = TIER_RANK[tier] >= 2 ? 2 : 1;
    if (ruleRank > maxAllowedRuleRank) {
      throw new Error(
        `Quality file for "${id}" claims tier "${tier}" but rule "${name}" belongs to a higher tier`,
      );
    }

    if (status === "exempt") {
      if (!comment || comment.trim() === "") {
        throw new Error(
          `Quality file for "${id}": rule "${name}" is exempt but carries no comment — the comment IS the rule`,
        );
      }
      rules[name] = { exempt: comment.trim() };
    } else {
      rules[name] = status as RuleStatus;
    }
  }

  if (tier === undefined) {
    throw new Error(`Quality file for "${id}" never declares a tier`);
  }
  return { tier, rules };
}

// ---------------------------------------------------------------------------
// The checker and the debt list
// ---------------------------------------------------------------------------

/** Capabilities that predate the entry tier and, unlike notion/slack/google, have no
 *  `integrations/<id>/integration.json` of their own to carry a `quality.yaml` — every
 *  `kind: "adapter"` entry in `persona/capability-docs.ts`'s `CAPABILITY_DOCS` that no manifest's
 *  `capability` list names (checked by hand against `CAPABILITY_DOCS` on 2026-09-19; `calendar`
 *  and `gmail` are covered by the `google` manifest, `notion` by its own).
 *
 *  Home Assistant's lesson (report 07 §2.2), and the same shape as `KNOWN_UNDECLARED_SECRETS` /
 *  `KNOWN_MISSING_PROBES`: this list may only SHRINK. An entry that gains a manifest and a
 *  quality file must be removed from the list in the SAME change — `checkQuality` fails the
 *  build otherwise. Committed as a literal array, never computed from `CAPABILITY_DOCS` at run
 *  time, or the ratchet would have nothing fixed to compare against. */
export const INTEGRATIONS_WITHOUT_SCALE: readonly string[] = [
  "markets",
  "orakel",
  "places",
  "strava",
  "transit",
  "twenty",
];

export interface QualityFinding {
  id: string;
  rule: string;
  message: string;
}

/** `manifest.quality` (e.g. `"integrations/notion/quality.yaml"`) is repo-root-relative, the
 *  same convention every `integration.json` on disk already uses. `dir` is the integrations
 *  folder itself (what `loadIntegrationManifests` takes), so its parent is repo root. */
function qualityFilePath(dir: string, quality: string): string {
  return resolve(dir, "..", quality);
}

/**
 * Every way a claimed tier can be unbacked, in one list — empty means the ladder holds for every
 * integration on disk. A `quality.yaml` is never trusted at face value: this reports a missing
 * file, an unparseable one (the parser's own message, which names the bad line or rule), a
 * `tier: gold` claim (wave 6 defines no gold rules yet — owner decision C2), a rule the claimed
 * tier requires that is not `done` or `exempt`, and a debt-list entry that has grown a quality
 * file of its own without being removed from `INTEGRATIONS_WITHOUT_SCALE`.
 */
export function checkQuality(dir: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const onDebtList = new Set(INTEGRATIONS_WITHOUT_SCALE);

  for (const manifest of loadIntegrationManifests(dir)) {
    const { id } = manifest;
    const path = qualityFilePath(dir, manifest.quality);

    if (onDebtList.has(id)) {
      findings.push({
        id,
        rule: "debt-list",
        message:
          `"${id}" is on INTEGRATIONS_WITHOUT_SCALE but now has a quality file at "${path}" — ` +
          `remove it from the list in this change.`,
      });
    }

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      findings.push({
        id,
        rule: "quality-file",
        message: `"${id}" names a quality file at "${manifest.quality}" that does not exist on disk.`,
      });
      continue;
    }

    let quality: QualityFile;
    try {
      quality = parseQualityFile(text, id);
    } catch (err) {
      findings.push({ id, rule: "parse", message: (err as Error).message });
      continue;
    }

    if (quality.tier === "gold") {
      findings.push({
        id,
        rule: "tier",
        message:
          `"${id}" claims tier "gold", but wave 6 defines no gold rules yet (owner decision C2) ` +
          `— a gold claim cannot be backed and is refused.`,
      });
      continue;
    }

    if (manifest.provenance === "contributed" && quality.tier === "none") {
      findings.push({
        id,
        rule: "provenance",
        message:
          `"${id}" is contributed but claims tier "none" ` +
          `— a contributed or shipped integration is held to the entry tier before it merges.`,
      });
      continue;
    }

    const requiredRank = TIER_RANK[quality.tier];
    const rulesToCheck: readonly string[] =
      requiredRank >= 2 ? [...BRONZE_RULES, ...SILVER_RULES] : requiredRank >= 1 ? BRONZE_RULES : [];

    for (const rule of rulesToCheck) {
      const status = quality.rules[rule];
      if (status === "done" || (typeof status === "object" && status !== null)) continue;
      findings.push({
        id,
        rule,
        message:
          status === "todo"
            ? `"${id}" claims tier "${quality.tier}" but rule "${rule}" is still "todo" — the tier is only as good as its rules.`
            : `"${id}" claims tier "${quality.tier}" but rule "${rule}" has no status at all.`,
      });
    }
  }

  return findings;
}

/** The tier `id`'s quality file backs today, or `null` when the integration, its manifest or its
 *  quality file cannot be found or fails to parse — fails soft, the way a read model should: a
 *  missing tier is absence of evidence, not a build failure (that is `checkQuality`'s job). */
export function tierOf(id: string, dir: string): Tier | null {
  const manifest = loadIntegrationManifests(dir).find((m) => m.id === id);
  if (!manifest) return null;
  try {
    const text = readFileSync(qualityFilePath(dir, manifest.quality), "utf8");
    return parseQualityFile(text, id).tier;
  } catch {
    return null;
  }
}
