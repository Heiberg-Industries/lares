// workflow-store-migrate.mjs — runs INSIDE a role image, never on the host and never in the engine.
//
// The agent framework keeps its durable state in one database per agent (an "agent store"), all
// cloned from one empty template. The framework's own package owns that schema and ships its own
// schema step, setupDatabase(). This program is the only thing that runs it: on a fresh template
// at install, and at update on the template and on every existing agent store.
//
// It is fed to `node --input-type=module -` on standard input with /app/services/<role> as the
// working directory, so `@workflow/world-postgres` and `pg` resolve to exactly what that role
// image runs (ops/engine-run.sh, workflow_store_step). It connects as lares_workflow_provisioner
// with the role lares_workflow_owner: the login that may create these objects, never a superuser.
//
//   node --input-type=module - check <database>
//   node --input-type=module - upgrade <database>
//   node --input-type=module - create <database>
//
// check prints exactly one word and changes nothing:
//   old      the package's record of applied steps is exactly what the previous release left
//   current  it is exactly this image's full list
//   empty    the database has no workflow objects at all (a fresh template)
// Anything else is a refusal: a plain reason on standard error and exit 3.
//
// upgrade runs the package's step when the store is `old`, does nothing when it is `current`, and
// refuses everything else. create runs it only on an `empty` database (a fresh install). The package's step
// ends the process itself, so there is no check after it here: the caller runs `check` again and
// requires `current`.
//
// Nothing here prints a password. The connection address carries none (the password arrives in
// PGPASSWORD), and the package prints the address with the login redacted.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const OWNER = "lares_workflow_owner";
const PROVISIONER = "lares_workflow_provisioner";
const REFUSED = 3;

// What the previous release's package left in workflow_drizzle.workflow_migrations, in order:
// "<created_at> <hash>" (created_at is the package journal's timestamp for the step, hash is the
// sha256 of the step's file). Kept equal to the first 20 entries of WORKFLOW_SCHEMA_STEPS in
// lib/workflow-database-privileges.ts by tests/workflow-store-update.integration.test.ts.
const LEFT_BY_PREVIOUS_RELEASE = [
  "1762873019948 e92421745b2346049a277afbce781da3f260e68067eb1bdbd7d10bbf2ad2e743",
  "1763903867386 5bb606a2a55a2095101907d62d28917091316d9cddcdff5e8fc9a43e2e6f7a30",
  "1764815363008 ac88e448e940f38bf18f076dde2abe63b53659a4c9936325e4e44cf95434e311",
  "1765900000000 ad911e947a121b1def77b7ad37bd95ae7de2b453a05645e9b40f979a166e79b9",
  "1765900000001 673b7222d0df6c2fd2d335072a9d85b695b5dae4a2c52b287d2aaa5d31d462f9",
  "1767723210726 7c3f3b73a707af2386f5c20b953e4c54631be616bf0b9bfa8ced1b97018ad384",
  "1768500000000 928760bfbdd23576f119f3f14c3e6db78fb765cfd24f8595c70536cb975c7178",
  "1769500000000 f904ecb9232a269f599b393fa4ce5e3762a8267d111ad103d56fdcd11837fdcd",
  "1770000000000 e424a48df5a1ddd752e4d09f05696e76da94e366b3d617ca10c3d3fbcdb74c77",
  "1770500000000 eafc36b3c9b1aaff44cd33cff9126bd7fdd796d2672b104125c32d91e0ce5597",
  "1771000000000 5584c9be57e2c0d82fa1e972d5ee5da711b31368fbf8efee16cd2857e071af41",
  "1771500000000 169d2d8dea24763593830768249a1832b951a8a456f3757a2a2aa08063b41f6b",
  "1775600000000 31308216105f22820ff834667fd3c34cc53939deeff5f56d9865f77a5579105d",
  "1779609600000 f22c7907d5cbfcf8e85801490677aae0fa9212fca01ad5a27aec0f8742cb2be7",
  "1780185600000 f09414bc7166d782e8c93f6d65e3b16493b56911b1a241356b382f7e6008439f",
  "1782691200000 adc88e08a9a0bba0bd13962db0c317b4e4aab4c6ae6ec281f2453dee9e4199c7",
  "1784937600000 f54db91ba1d89a06bfa1dcd6f869dfe419b94fc54b0329052e2a18e314ee5a82",
  "1785283200000 4ce073262fcb6bb23919f5c57df2bd513b95bff75d104a0c9131840eca6e4846",
  "1785619990000 28feaa8700bbe8ca2402e9b50db2b966e70b9be954eb1c75579a67adba1a7d98",
  "1786060800000 81e4aa926131374e338b11c2a2b6105266617f5b7f75b02cf966afd834dbc0bf",
];
// Objects the newer steps add. A record that says `old` beside any of these, or `current` without
// all of them, is a store somebody changed by hand.
const ADDED_BY_THIS_RELEASE = [
  "workflow.workflow_invocations", "workflow.workflow_snapshots", "workflow.workflow_start_hook_admissions",
  "workflow.workflow_job_lock_holders", "workflow.workflow_invocations_sequence_seq",
];
const QUEUE_STEPS = 18;

class Refusal extends Error {}
const refuse = (reason) => { throw new Refusal(reason); };
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** This image's own full list, read from the package it will run: "<created_at> <hash>" each. */
function stepsInThisImage() {
  const folder = join(dirname(fileURLToPath(import.meta.resolve("@workflow/world-postgres/cli"))), "..", "src", "drizzle", "migrations");
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8"));
  if (!Array.isArray(journal?.entries)) refuse("this image's workflow package has no readable list of schema steps");
  const steps = journal.entries.map((entry) => {
    if (typeof entry?.tag !== "string" || !/^[a-z0-9_]+$/i.test(entry.tag) || !Number.isSafeInteger(entry.when))
      refuse("this image's workflow package lists a schema step in a form this program does not know");
    return `${entry.when} ${createHash("sha256").update(readFileSync(join(folder, `${entry.tag}.sql`))).digest("hex")}`;
  });
  if (steps.length <= LEFT_BY_PREVIOUS_RELEASE.length || !same(steps.slice(0, LEFT_BY_PREVIOUS_RELEASE.length), LEFT_BY_PREVIOUS_RELEASE))
    refuse("this image's workflow package does not continue from the schema the previous release left");
  return steps;
}

/** `old`, `current` or `empty`; refuses everything else. Reads only. */
async function check(database) {
  const expected = stepsInThisImage();
  const pool = new pg.Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const self = (await pool.query(`
      SELECT current_user,session_user,current_database() AS database,
        (SELECT rolsuper FROM pg_roles WHERE rolname=session_user) AS superuser,
        current_setting('TimeZone') AS zone,current_setting('workflow.legacy_timezone',true) AS legacy
    `)).rows[0];
    if (self?.current_user !== OWNER || self.session_user !== PROVISIONER || self.database !== database || self.superuser !== false)
      refuse("the database login did not prove the workflow owner's identity on the named database");
    // The step that turns every stored time into "with time zone" reads this session's zone to
    // decide whether to move stored values. Only UTC leaves every stored moment as it is.
    if ((self.zone !== "UTC" && self.zone !== "Etc/UTC") || (self.legacy ?? "") !== "")
      refuse(`the database is set to time zone ${self.legacy || self.zone}, not UTC. This release only upgrades agent stores on UTC: the upgrade rewrites how every stored time is kept, and that is only proven on UTC. Stay on your current release for now, and do not change the database's time zone yourself: that would move the times already stored`);

    const objects = Number((await pool.query(`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('workflow','workflow_drizzle','graphile_worker')
    `)).rows[0].n);
    const hasRecord = (await pool.query("SELECT to_regclass('workflow_drizzle.workflow_migrations') IS NOT NULL AS present")).rows[0].present === true;
    if (!hasRecord) {
      if (objects === 0) return "empty";
      refuse("it has workflow tables but no record of applied schema steps, so it was not left by the previous release");
    }
    const recorded = (await pool.query("SELECT hash,created_at::text AS created_at FROM workflow_drizzle.workflow_migrations ORDER BY id")).rows
      .map((row) => `${row.created_at} ${row.hash}`);
    const isOld = same(recorded, LEFT_BY_PREVIOUS_RELEASE);
    const isCurrent = same(recorded, expected);
    if (!isOld && !isCurrent) {
      const known = recorded.every((value, index) => value === expected[index]);
      refuse(`it was not left by the previous release: it has ${recorded.length} schema steps recorded` +
        (known ? "" : ", and at least one is not a step this release knows") +
        `; I expect exactly ${LEFT_BY_PREVIOUS_RELEASE.length} (the previous release) or ${expected.length} (already upgraded)`);
    }
    const present = (await pool.query("SELECT name FROM unnest($1::text[]) AS wanted(name) WHERE to_regclass(name) IS NOT NULL", [ADDED_BY_THIS_RELEASE])).rows.length;
    if (isOld && present !== 0) refuse("its record says it has not been upgraded, but it already has tables this release adds");
    if (isCurrent && present !== ADDED_BY_THIS_RELEASE.length) refuse("its record says it has been upgraded, but tables this release adds are missing");
    if ((await pool.query("SELECT to_regclass('graphile_worker.migrations') IS NOT NULL AS present")).rows[0].present !== true)
      refuse("it has no job queue record, so it was not left by the previous release");
    const queue = (await pool.query("SELECT id FROM graphile_worker.migrations ORDER BY id")).rows.map((row) => Number(row.id));
    if (!same(queue, Array.from({ length: QUEUE_STEPS }, (_, index) => index + 1)))
      refuse(`its job queue is not at the version this release runs (${queue.length} steps recorded, ${QUEUE_STEPS} expected)`);
    return isOld ? "old" : "current";
  } finally {
    await pool.end();
  }
}

async function main() {
  const [mode, database] = process.argv.slice(2);
  if (!["check", "upgrade", "create"].includes(mode ?? "")) throw new Error("choose check, upgrade or create");
  if (database !== "empty_workflow" && !/^lares_[a-f0-9]{32}$/.test(database ?? "")) throw new Error("unsupported database name");
  let address;
  try { address = new URL(process.env.WORKFLOW_POSTGRES_URL ?? ""); } catch { throw new Error("no usable database address was given"); }
  if (address.password || address.username !== PROVISIONER || decodeURIComponent(address.pathname) !== `/${database}` || address.search)
    throw new Error("the database address must name the provisioner login and the named database, with no password and no options");
  // The package falls back to DATABASE_URL; make sure there is no second address to fall back to.
  delete process.env.DATABASE_URL;

  const state = await check(database);
  if (mode === "check") {
    process.stdout.write(`${state}\n`);
    return;
  }
  if (state === "current") {
    if (mode === "create") refuse("it already has this release's workflow schema; a fresh install expects an empty database");
    process.stdout.write("already at this release's workflow schema; nothing to do\n");
    return;
  }
  if (mode === "upgrade" && state !== "old") refuse("it is empty; an update only upgrades a store the previous release left");
  if (mode === "create" && state !== "empty") refuse("it already has workflow tables; a fresh install expects an empty database");
  const { setupDatabase } = await import("@workflow/world-postgres/cli");
  // Applies every pending step in one transaction, then ends this process: 0 done, 1 failed.
  await setupDatabase();
}

main().catch((error) => {
  if (error instanceof Refusal) {
    process.stderr.write(`workflow store: ${error.message}\n`);
    process.exit(REFUSED);
  }
  process.stderr.write(`workflow store: the check could not be completed (${error instanceof Error ? error.message : "unknown error"})\n`);
  process.exit(1);
});
