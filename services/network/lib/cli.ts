import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, openDbReadOnly, DEFAULT_DB_PATH } from "./db.js";
import { loadConfig, resolveTwentyApiKey, resolveSlackToken, resolveSlackUserToken, type NetworkConfig } from "./config.js";
import { runImport } from "./import-all.js";
import { importSlack } from "./importers/slack.js";
import { createSlackReader } from "./importers/slack-reader.js";
import { whoAt, dormantQueue, personProfile, readOnlySql } from "./queries.js";
import { mergeContacts, detachIdentity, linkToTwenty } from "./resolve.js";
import { planDedup, applyDedup } from "./dedup.js";
import { classifyJunkPeople } from "./twenty-cleanup.js";
import { createTwentyClient, type TwentyClient } from "./twenty.js";
import { syncTwenty } from "./twenty-sync.js";
import { runDigest } from "./digest.js";
import { postSlackMessage } from "./slack.js";
import { regenerateBrainNotes } from "./brain-notes.js";
import { exportStrippedReplica, CONTENT_WINDOW_DAYS } from "./replica.js";

/**
 * Default wall-clock budget for one `slack-import` run (ORB-149 closing fixes, item 4). The
 * runbook's own next step is to add this command ahead of `backup`, `digest`, `brain-notes`,
 * and `push-network-replica.sh` in the 09:30 launchd chain — an ordinary run finishes in well
 * under a minute (nothing here is normally rate-limited), so this bound only bites under
 * sustained Tier-3 pressure, and 15 minutes leaves the rest of that chain a defensible amount
 * of headroom before whatever runs after it that morning while still giving a genuinely busy
 * first backfill several bounded 429-retry cycles to make real progress before giving up.
 */
const DEFAULT_SLACK_DEADLINE_MINUTES = 15;

/** Shared config→keychain→client preamble for the Twenty commands. Null = already errored. */
function twentyClientFromConfig(config: NetworkConfig): TwentyClient | null {
  if (!config.twentyBaseUrl) {
    console.error('Set "twentyBaseUrl" in ~/.lares/config.json, e.g. { "twentyBaseUrl": "https://crm.owner.example" }');
    process.exitCode = 1;
    return null;
  }
  let key: string;
  try {
    key = resolveTwentyApiKey(config);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return null;
  }
  return createTwentyClient(config.twentyBaseUrl, key);
}

/**
 * Parses a CLI budget override (`--max-messages`/`--max-requests`/`--max-pages`/
 * `--deadline-minutes`) into a positive integer, or `undefined` when the flag was omitted.
 * Rejects anything that isn't ALL digits — not just anything `parseInt` can't parse at all.
 * `parseInt` itself stops at the first non-digit character rather than failing
 * (`parseInt("50abc", 10) === 50`, `parseInt("1e9", 10) === 1`), so checking only
 * `Number.isFinite`/`<= 0` after the fact would silently accept a typo'd flag value as a
 * smaller-than-intended budget instead of erroring (ORB-149 closing fixes, item 5 — an
 * earlier version of this comment overclaimed "throws rather than returning NaN", true only
 * for a value with no leading digits at all, e.g. "abc").
 */
function parsePositiveIntFlag(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return n;
}

/** Friendly guard for read commands run before the first import. */
function openExistingDbReadOnly(): ReturnType<typeof openDbReadOnly> {
  if (!existsSync(DEFAULT_DB_PATH)) {
    console.error(`No database at ${DEFAULT_DB_PATH} yet — run "pnpm network import" first.`);
    process.exit(1);
  }
  return openDbReadOnly();
}

export function registerNetworkCommands(program: Command): void {
  const net = program.command("network").description("Local relationship intelligence (LinkedIn + Contacts + iMessage + calls)");

  net
    .command("import")
    .description("Ingest all local sources; pass --linkedin <dir> and/or --meta <dir> to also ingest exports")
    .option("--linkedin <dir>", "path to an unzipped LinkedIn data-export folder")
    .option("--meta <dir>", "path to the Meta export root (~/.lares/exports/meta)")
    .action((opts: { linkedin?: string; meta?: string }) => {
      const config = loadConfig();
      const db = openDb();
      const report = runImport(db, {
        linkedInDir: opts.linkedin,
        ownLinkedInUrl: config.ownLinkedInUrl,
        metaDir: opts.meta,
        ownMetaName: config.ownMetaName,
      });
      db.close();
      console.log(JSON.stringify(report, null, 2));
      if (opts.linkedin) {
        console.log(`\nReminder: delete the raw export at ${opts.linkedin} once you've sanity-checked the counts above.`);
      }
      if (opts.meta) {
        console.log(`\nReminder: delete the raw Meta exports under ${opts.meta} once you've sanity-checked the counts above (they contain private messages).`);
      }
    });

  net
    .command("slack-import")
    .description(
      "Import Slack signals (all conversation types, content-stripped) into the relationship graph — own command " +
        "because it's async (see lib/importers/slack.ts). Needs a Slack USER token (docs/runbooks/slack-user-token.md).",
    )
    .requiredOption("--own-user-id <id>", "Bendik's own Slack user id (for direction classification and thread-reply detection)")
    .option("--max-messages <n>", "override maxMessagesPerRun (default 1000) — total messages scanned across the whole run")
    .option("--max-requests <n>", "override maxRequestsPerRun (default 200) — total history/getUserInfo requests across the whole run")
    .option("--max-pages <n>", "override maxPagesPerConversation (default 20)")
    .option(
      "--deadline-minutes <n>",
      `override the run's wall-clock deadline (default ${DEFAULT_SLACK_DEADLINE_MINUTES}) — a rate-limit sleep that would cross it stops the run (stoppedEarly: "rate_limited") instead of sleeping past it`,
    )
    .action(async (opts: { ownUserId: string; maxMessages?: string; maxRequests?: string; maxPages?: string; deadlineMinutes?: string }) => {
      const config = loadConfig();
      let token: string;
      let maxMessagesPerRun: number | undefined;
      let maxRequestsPerRun: number | undefined;
      let maxPagesPerConversation: number | undefined;
      let deadlineMinutes: number;
      try {
        token = resolveSlackUserToken(config);
        maxMessagesPerRun = parsePositiveIntFlag(opts.maxMessages, "--max-messages");
        maxRequestsPerRun = parsePositiveIntFlag(opts.maxRequests, "--max-requests");
        maxPagesPerConversation = parsePositiveIntFlag(opts.maxPages, "--max-pages");
        deadlineMinutes = parsePositiveIntFlag(opts.deadlineMinutes, "--deadline-minutes") ?? DEFAULT_SLACK_DEADLINE_MINUTES;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      // The CLI is the one place allowed to call the real clock directly (same pattern as the
      // `digest` command's `now: new Date()` below) — everything downstream of this point
      // (slack-reader.ts's `deadlineAt` check) takes it as an explicit injected value, never a
      // bare `new Date()`/`Date.now()` of its own.
      const deadlineAt = new Date(Date.now() + deadlineMinutes * 60_000);
      const reader = createSlackReader({ token, ownUserId: opts.ownUserId, deadlineAt });
      const db = openDb();
      try {
        const summary = await importSlack(db, reader, {
          ownUserId: opts.ownUserId,
          maxMessagesPerRun,
          maxRequestsPerRun,
          maxPagesPerConversation,
        });
        console.log(JSON.stringify(summary, null, 2));
        if (summary.stoppedEarly) {
          console.log(`\nStopped early (${summary.stoppedEarly.reason}) — re-run to continue from the saved cursor.`);
        }
        if (summary.scopeWarnings.length > 0) {
          for (const w of summary.scopeWarnings) console.warn(`\nWARNING: ${w}`);
        }
        // review round 2, Important 2: importSlack NEVER throws for a listConversations
        // failure, a rate limit, or a per-conversation error — it records them into
        // summary.errors/stoppedEarly and returns a summary of zeros instead. Without this,
        // a revoked token, a missing scope, or a 429 abort all print clean-looking JSON and
        // exit 0 — indistinguishable from a real success in a daily cron.
        if (summary.errors.length > 0 || summary.stoppedEarly?.reason === "rate_limited") {
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
    });

  net
    .command("who-at <company>")
    .description("Contacts at a company, warmest first")
    .action((company: string) => {
      const db = openExistingDbReadOnly();
      console.table(whoAt(db, company).map((r) => ({ name: r.displayName, title: r.title, band: r.band, last: r.lastInteractionAt?.slice(0, 10) ?? "—" })));
      db.close();
    });

  net
    .command("dormant")
    .description("Reactivation queue: once-warm contacts gone quiet")
    .option("--limit <n>", "max rows", "25")
    .action((opts: { limit: string }) => {
      const db = openExistingDbReadOnly();
      console.table(dormantQueue(db, parseInt(opts.limit, 10)).map((r) => ({ name: r.displayName, company: r.company, last: r.lastInteractionAt?.slice(0, 10) ?? "—" })));
      db.close();
    });

  net
    .command("person <name>")
    .description("One contact: profile, pulse, recent interactions")
    .action((name: string) => {
      const db = openExistingDbReadOnly();
      const p = personProfile(db, name);
      db.close();
      if (!p) { console.error(`No contact matching "${name}"`); process.exitCode = 1; return; }
      console.log(JSON.stringify(p, null, 2));
    });

  net
    .command("sql <query>")
    .description("Read-only SQL (SELECT/WITH) against the network db")
    .action((query: string) => {
      const db = openExistingDbReadOnly();
      console.log(JSON.stringify(readOnlySql(db, query), null, 2));
      db.close();
    });

  net
    .command("merge <fromId> <intoId>")
    .description("Merge two contacts that are the same person")
    .action((fromId: string, intoId: string) => {
      const db = openDb();
      mergeContacts(db, parseInt(fromId, 10), parseInt(intoId, 10));
      db.close();
      console.log(`Merged contact ${fromId} into ${intoId}.`);
    });

  net
    .command("detach <identityId>")
    .description("Detach a mis-attributed identity into its own contact")
    .action((identityId: string) => {
      const db = openDb();
      const newId = detachIdentity(db, parseInt(identityId, 10));
      db.close();
      console.log(`Detached identity ${identityId} into new contact ${newId}.`);
    });

  net
    .command("link <contactId> <twentyId>")
    .description("Link a local contact to a specific Twenty person id (clears a name-only ambiguous match)")
    .action((contactId: string, twentyId: string) => {
      if (!/^\d+$/.test(contactId)) {
        console.error(`Invalid contact id "${contactId}" — expected a number`);
        process.exitCode = 1;
        return;
      }
      const db = openDb();
      try {
        linkToTwenty(db, parseInt(contactId, 10), twentyId);
        console.log(`Linked contact ${contactId} to Twenty person ${twentyId}.`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        db.close();
      }
    });

  net
    .command("dedup")
    .description("Merge same-name contact fragments split across sources; dry-run by default, --apply to write")
    .option("--apply", "actually merge (default is a dry run)")
    .option("--show-held", "also print the clusters held back for manual review")
    .action((opts: { apply?: boolean; showHeld?: boolean }) => {
      if (!existsSync(DEFAULT_DB_PATH)) {
        console.error(`No database at ${DEFAULT_DB_PATH} yet — run "pnpm network import" first.`);
        process.exitCode = 1;
        return;
      }
      const db = openDb();
      try {
        const plan = planDedup(db);
        console.log(opts.apply ? "APPLIED" : "DRY RUN (pass --apply to write)");
        console.log(`safe merges:    ${plan.merges.length}`);
        console.log(`held (review):  ${plan.held.length}`);
        const heldByReason = plan.held.reduce<Record<string, number>>((acc, h) => {
          acc[h.reason] = (acc[h.reason] ?? 0) + 1;
          return acc;
        }, {});
        for (const [reason, n] of Object.entries(heldByReason)) console.log(`  - ${reason}: ${n}`);
        if (opts.showHeld) {
          console.table(plan.held.map((h) => ({ name: h.name, ids: h.ids.join(", "), reason: h.reason })));
        }
        if (opts.apply) {
          const n = applyDedup(db, plan);
          console.log(`Merged ${n} fragment pairs. Re-run "pnpm network sync-twenty" to re-link Twenty.`);
        } else if (plan.merges.length) {
          console.log('Sample of proposed merges (survivor <- fragment):');
          console.table(plan.merges.slice(0, 25).map((m) => ({ name: m.name, survivor: m.survivorId, merges: m.fromId })));
          console.log(`(${plan.merges.length} total — pass --apply to perform them, --show-held to see what's held back)`);
        }
      } finally {
        db.close();
      }
    });

  net
    .command("browse")
    .description("Open Datasette on the network db (requires uv: brew install uv)")
    .action(() => {
      if (!existsSync(DEFAULT_DB_PATH)) { console.error(`No database at ${DEFAULT_DB_PATH} — run "pnpm network import" first.`); process.exitCode = 1; return; }
      const res = spawnSync("uvx", ["datasette", DEFAULT_DB_PATH, "--open"], { stdio: "inherit" });
      if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
        console.error('Datasette needs uv. Install with: brew install uv');
        process.exitCode = 1;
      }
    });

  net
    .command("backup")
    .description("Copy the network db to the NAS path configured in ~/.lares/config.json")
    .action(() => {
      const config = loadConfig();
      if (!config.nasBackupPath) { console.error('Set "nasBackupPath" in ~/.lares/config.json (a mounted NAS directory).'); process.exitCode = 1; return; }
      if (!existsSync(config.nasBackupPath)) { console.error(`NAS path not mounted: ${config.nasBackupPath}`); process.exitCode = 1; return; }
      const db = openExistingDbReadOnly();
      // sqlite-consistent snapshot via VACUUM INTO a temp file, then copy
      const tmp = DEFAULT_DB_PATH + ".backup-tmp";
      rmSync(tmp, { force: true });
      db.prepare("VACUUM INTO ?").run(tmp);
      db.close();
      const dest = join(config.nasBackupPath, "network.db");
      copyFileSync(tmp, dest);
      rmSync(tmp, { force: true });
      console.log(`Backed up to ${dest}`);
    });

  net
    .command("export-replica <dest>")
    .description("Write a network.db replica for the agent box (Meta channels always stripped; rest windowed to 90 days)")
    .action((dest: string) => {
      if (!existsSync(DEFAULT_DB_PATH)) { console.error(`No network db at ${DEFAULT_DB_PATH}. Run "pnpm network import" first.`); process.exitCode = 1; return; }
      const { rowsStripped, rowsKept } = exportStrippedReplica(DEFAULT_DB_PATH, dest);
      console.log(
        `Wrote replica to ${dest} (${rowsStripped} stripped — Meta or older than ${CONTENT_WINDOW_DAYS} days; ${rowsKept} kept)`,
      );
    });

  net
    .command("sync-twenty")
    .description("Match local contacts to Twenty people; dry-run by default, --apply to write")
    .option("--apply", "actually write (default is a dry run)")
    .action(async (opts: { apply?: boolean }) => {
      if (!existsSync(DEFAULT_DB_PATH)) {
        console.error(`No database at ${DEFAULT_DB_PATH} yet — run "pnpm network import" first.`);
        process.exitCode = 1;
        return;
      }
      const config = loadConfig();
      const client = twentyClientFromConfig(config);
      if (!client) return;
      const db = openDb(); // sync writes identities/cache; in dry-run mode syncTwenty guarantees zero writes
      try {
        const report = await syncTwenty(db, client, { dryRun: !opts.apply, selfContactId: config.selfContactId });
        console.log(opts.apply ? "APPLIED" : "DRY RUN (pass --apply to write)");
        console.log(`matchedByEmail: ${report.matchedByEmail}`);
        console.log(`matchedByName:  ${report.matchedByName}`);
        console.log(`ambiguous:      ${report.ambiguous.length}`);
        console.log(`enriched:       ${report.enriched}`);
        console.log(`pulled:         ${report.pulled}`);
        console.log(`unmatched:      ${report.unmatched}`);
        console.log(`failures:       ${report.failures.length}`);
        if (report.ambiguous.length) {
          console.table(report.ambiguous.map((a) => ({ contactId: a.contactId, displayName: a.displayName, candidates: a.candidates.join(" | ") })));
          console.log("Resolve manually: pnpm network merge <fromId> <intoId> (same person, two local rows), pnpm network link <contactId> <twentyId> (name-only match), or dedupe the record in Twenty, then re-run.");
        }
        if (report.failures.length) console.table(report.failures);
      } finally {
        db.close();
      }
    });

  net
    .command("twenty-cleanup")
    .description("Find newsletter/order/no-reply people auto-created by Twenty's email sync; dry-run by default, --apply to delete")
    .option("--apply", "actually delete the junk people (default is a dry run)")
    .action(async (opts: { apply?: boolean }) => {
      const config = loadConfig();
      const client = twentyClientFromConfig(config);
      if (!client) return;

      // Relationship + curation protection sets.
      const [people, opps, noteIds, taskIds] = await Promise.all([
        client.listPeopleForCleanup(),
        client.listOpportunities(),
        client.listNoteTargetPersonIds(),
        client.listTaskTargetPersonIds(),
      ]);
      const laresLinkedIds = new Set<string>();
      if (existsSync(DEFAULT_DB_PATH)) {
        const db = openDbReadOnly();
        for (const r of db.prepare("SELECT value FROM identities WHERE kind = 'twenty_id'").all() as { value: string }[]) {
          laresLinkedIds.add(r.value);
        }
        db.close();
      }

      const { junk, protectedByRelationship } = classifyJunkPeople(people, {
        oppPersonIds: new Set(opps.map((o) => o.pointOfContactId).filter((x): x is string => !!x)),
        notePersonIds: new Set(noteIds),
        taskPersonIds: new Set(taskIds),
        laresLinkedIds,
      });

      console.log(opts.apply ? "APPLIED" : "DRY RUN (pass --apply to delete)");
      console.log(`people scanned:        ${people.length}`);
      console.log(`junk to remove:        ${junk.length}`);
      console.log(`protected (deal/note/task/curated): ${protectedByRelationship}`);
      if (junk.length && !opts.apply) {
        console.table(junk.slice(0, 60).map((j) => ({ name: j.name, email: j.email })));
        if (junk.length > 60) console.log(`…and ${junk.length - 60} more. Pass --apply to delete all ${junk.length}.`);
      }
      if (opts.apply) {
        let deleted = 0;
        const failures: { email: string; error: string }[] = [];
        for (const j of junk) {
          try {
            await client.deletePerson(j.id);
            deleted += 1;
          } catch (err) {
            failures.push({ email: j.email, error: err instanceof Error ? err.message : String(err) });
          }
        }
        console.log(`Deleted ${deleted} junk people.`);
        if (failures.length) console.table(failures);
      }
    });

  net
    .command("push <contactId>")
    .description("Create a local contact as a person in Twenty (never creates companies)")
    .requiredOption("--brand <brand>", "orakel | zero7 | murmur | voldenuit")
    .action(async (contactId: string, opts: { brand: string }) => {
      if (!/^\d+$/.test(contactId)) {
        console.error(`Invalid contact id "${contactId}" — expected a number (find it via "pnpm network person <name>")`);
        process.exitCode = 1;
        return;
      }
      const config = loadConfig();
      const client = twentyClientFromConfig(config);
      if (!client) return;
      const id = parseInt(contactId, 10);
      const db = openDb();
      try {
        const contact = db
          .prepare("SELECT id, display_name, company, title, resolved FROM contacts WHERE id = ?")
          .get(id) as { id: number; display_name: string; company: string | null; title: string | null; resolved: number } | undefined;
        if (!contact) { console.error(`No contact with id ${id}`); process.exitCode = 1; return; }
        if (contact.resolved === 0) {
          console.error(`contact ${id} is an unresolved bare handle — merge it onto a named contact first`);
          process.exitCode = 1;
          return;
        }
        const identities = db
          .prepare("SELECT kind, value FROM identities WHERE contact_id = ? ORDER BY id")
          .all(id) as { kind: string; value: string }[];
        const existing = identities.find((i) => i.kind === "twenty_id");
        if (existing) {
          console.error(`already linked to Twenty person ${existing.value}`);
          process.exitCode = 1;
          return;
        }

        // Last whitespace-separated word = lastName, rest = firstName.
        const words = contact.display_name.trim().split(/\s+/);
        const lastName = words.length > 1 ? words[words.length - 1]! : "";
        const firstName = words.length > 1 ? words.slice(0, -1).join(" ") : words[0]!;

        let companyId: string | undefined;
        if (contact.company) {
          const found = await client.findCompanyByName(contact.company);
          if (found) companyId = found.id; // no company creation ever
        }

        const email = identities.find((i) => i.kind === "email")?.value;
        const phone = identities.find((i) => i.kind === "phone")?.value;
        const linkedinUrl = identities.find((i) => i.kind === "linkedin_url")?.value;

        const createdId = await client.createPerson({ firstName, lastName, email, phone, linkedinUrl, brand: opts.brand, companyId });

        db.prepare("INSERT OR IGNORE INTO identities (contact_id, kind, value, source) VALUES (?, 'twenty_id', ?, 'push')").run(id, createdId);
        db.prepare("UPDATE contacts SET twenty_id_cache = ? WHERE id = ?").run(createdId, id);
        console.log(`Created Twenty person ${createdId}`);
      } finally {
        db.close();
      }
    });

  net
    .command("digest")
    .description("Weekly Slack digest: reactivation queue, fresh signals, warm paths into the pipeline (idempotent per ISO week)")
    .option("--dry-run", "print the message without posting or recording")
    .action(async (opts: { dryRun?: boolean }) => {
      if (!existsSync(DEFAULT_DB_PATH)) {
        console.error(`No database at ${DEFAULT_DB_PATH} yet — run "pnpm network import" first.`);
        process.exitCode = 1;
        return;
      }
      const config = loadConfig();
      if (!config.digestSlackChannel) {
        console.error('Set "digestSlackChannel" in ~/.lares/config.json, e.g. { "digestSlackChannel": "#heiberg-ops" }');
        process.exitCode = 1;
        return;
      }
      // Twenty is optional for the digest: without it the warm-paths section is skipped.
      let twenty: TwentyClient | null = null;
      if (config.twentyBaseUrl) {
        twenty = twentyClientFromConfig(config);
        if (!twenty) return; // base URL set but key missing — already errored
      }
      const channel = config.digestSlackChannel;
      const db = openDb(); // runDigest writes digest_runs on success
      try {
        const result = await runDigest(db, {
          channel,
          now: new Date(),
          dryRun: !!opts.dryRun,
          twenty,
          // Token resolved lazily: a dry run needs no Slack credentials.
          post: (msg) => postSlackMessage({ token: resolveSlackToken(config) }, msg),
        });
        if (result.status === "already-posted") console.log(`Digest already posted for ${result.isoWeek} — nothing to do.`);
        else if (result.status === "dry-run") console.log(result.text);
        else console.log(`Posted digest for ${result.isoWeek} to ${channel}.`);
      } finally {
        db.close();
      }
    });

  net
    .command("brain-notes")
    .description("Regenerate derived person/company notes for active relationships into the Heiberg Brain vault")
    .option("--dry-run", "report planned writes/retirements without touching the vault")
    .action((opts: { dryRun?: boolean }) => {
      const config = loadConfig();
      if (!config.brainVaultPath) {
        console.error('Set "brainVaultPath" in ~/.lares/config.json (the Heiberg Brain vault root).');
        process.exitCode = 1;
        return;
      }
      if (!config.brainOwnerUserId) {
        console.error(
          'Set "brainOwnerUserId" in ~/.lares/config.json — the canonical user id (identity registry) of the person ' +
            "whose network this is, e.g. { \"brainOwnerUserId\": \"bendik\" }. It becomes `owner:` on every derived note; " +
            "the vault's scope filter shows a private note only to its owner (one importer per member).",
        );
        process.exitCode = 1;
        return;
      }
      if (!existsSync(config.brainVaultPath)) {
        console.error(`Vault path not found (iCloud not synced?): ${config.brainVaultPath}`);
        process.exitCode = 1;
        return;
      }
      const db = openExistingDbReadOnly();
      try {
        const r = regenerateBrainNotes(db, { vaultPath: config.brainVaultPath, now: new Date(), dryRun: !!opts.dryRun, owner: config.brainOwnerUserId });
        const verb = r.dryRun ? "Would write" : "Wrote";
        const stamp = new Date().toISOString().slice(0, 10);
        console.log(
          `brain-notes ${stamp}: ${verb} ${r.written.length} note(s), ${r.unchanged} unchanged, ` +
            `${r.deleted.length} retired to _archive, ${r.reclaimed.length} reclaimed.`,
        );
        if (r.skipped.length) console.error(`Skipped ${r.skipped.length} unreadable file(s):\n${r.skipped.join("\n")}`);
        for (const p of r.deleted) console.log(`  retire  ${p}`);
        for (const p of r.reclaimed) console.log(`  reclaim ${p}`);
        if (r.dryRun) for (const p of r.written) console.log(`  write  ${p}`);
      } finally {
        db.close();
      }
    });
}
