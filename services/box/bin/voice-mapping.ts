// services/box/bin/voice-mapping.ts — `lares voices map`, inside the engine image.
//
//   voice-mapping.ts [--apply] [--map <mailbox>=<account id>]...
//
// Links today's mailbox writing voices to connected accounts and members, and copies the shared
// default card into the installation owner's profile (lib/voice-mapping.ts says exactly what and
// when). A report by default; `--apply` makes the changes in one transaction and checks them.
// Exit codes: 0 done · 1 failed, nothing changed · 64 bad usage · 78 refused, nothing changed.
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { poolFromEnv } from "../lib/db.js";
import {
  applyVoiceMapping, dryRunVoiceMapping, parseMapArgument, renderVoiceMappingReport,
  VoiceMappingNotReady, VoiceMappingUsageError,
} from "../lib/voice-mapping.js";

const HELP = [
  "lares voices map [--apply] [--map <mailbox>=<account id>]...",
  "",
  "Links each mailbox's writing card and examples to the connected account it belongs to, and so",
  "to that account's member. Without --apply it only prints a report and changes nothing.",
  "",
  "  --map <mailbox>=<account id>  Link a held mailbox to this account. Repeatable.",
  "  --apply                       Make the changes in the report, all together, and check them.",
].join("\n");

export async function main(argv: readonly string[], deps: { db?: Pool; out: (s: string) => void; error: (s: string) => void }): Promise<number> {
  let apply = false;
  const maps: { mailbox: string; accountId: string }[] = [];
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--help" || a === "-h") { deps.out(HELP); return 0; }
      if (a === "--apply") { apply = true; continue; }
      if (a === "--map") {
        const v = argv[++i];
        if (v === undefined) throw new VoiceMappingUsageError("--map needs <mailbox>=<account id>.");
        maps.push(parseMapArgument(v));
        continue;
      }
      throw new VoiceMappingUsageError(`I do not know the option ${a}.`);
    }
    if (!deps.db) throw new Error("no database connection");
    if (!apply) {
      deps.out(renderVoiceMappingReport(await dryRunVoiceMapping(deps.db, maps), "dry-run"));
      return 0;
    }
    const outcome = await applyVoiceMapping(deps.db, maps);
    if (outcome.kind === "applied") { deps.out(renderVoiceMappingReport(outcome.plan, "applied")); return 0; }
    if (outcome.kind === "refused") { deps.out(renderVoiceMappingReport(outcome.plan, "refused")); return 78; }
    deps.error(`voices map: ${outcome.reason}`);
    return 1;
  } catch (err) {
    if (err instanceof VoiceMappingUsageError) { deps.error(`voices map: ${err.message} Nothing was changed.`); return 64; }
    if (err instanceof VoiceMappingNotReady) { deps.error(`voices map: ${err.message} Nothing was changed.`); return 78; }
    deps.error(`voices map: the database could not be read (${err instanceof Error ? err.message : String(err)}). Nothing was changed.`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wantsHelp = process.argv.slice(2).some((a) => a === "--help" || a === "-h");
  let db: Pool | undefined;
  try { db = wantsHelp ? undefined : poolFromEnv(); } catch (err) {
    process.stderr.write(`voices map: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.\n`);
    process.exit(1);
  }
  main(process.argv.slice(2), { db, out: (s) => process.stdout.write(s + "\n"), error: (s) => process.stderr.write(s + "\n") })
    .then((code) => { process.exitCode = code; })
    .finally(() => db?.end());
}
