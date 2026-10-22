// services/box/bin/erase-person.ts — the ONLY way to run an erase.
//
// NEVER A TOOL, NEVER A SCHEDULE, NEVER A BUTTON IN THE CONSOLE. Erasing a person is not
// something an agent should be able to decide to do, or be talked into doing, and it is not
// something a nightly job should ever do unattended. It is a command somebody types, at a
// terminal, on the server they own.
//
// DRY RUN IS THE DEFAULT. Run with no flags and nothing is changed: the report says what a real
// run would remove and what it would not reach. `--apply` is the only thing that writes.
//
// Practice runs can use the package script. Apply is run through the existing Keeper image by
// root on Linux after Keeper and all selected vault writers have been stopped.
//
// <who> is whatever you have: the person's id in the register, an old chat handle, an email
// address. Anybody the register does not hold is refused — this erases MEMBERS of this
// installation, never a third party somebody's notes happen to mention.
//
// `--vault <path>` (repeatable) is this installation's vault(s) — a note store on the same
// filesystem, checked out as a git working tree. Without at least one, this command only ever
// touches the database; the report says so plainly rather than pretending nothing was left in a
// vault to check. All of the actual ordering (resolve the person once; a database dry run first;
// then the vault; then the real database erase, with the exact paths the vault pass removed) is
// `../lib/run-erase.ts`'s job — this file only reads argv and prints what comes back.
//
// WHY THIS TALKS IN FULL SENTENCES, like migrate.ts next to it: whoever reads this output is
// doing something irreversible, and is not necessarily a developer. `main` never throws.

import { runErase, renderRunEraseReport } from "../lib/run-erase.js";
import type {BudgetNativeCustodyStore} from '../../keeper/lib/budget-native-custody.js';
import type { Pool } from "pg";
import type {HostFinancialJournal} from "../../keeper/lib/financial-journal.js";

export interface ParsedEraseArgs {
  person?: string;
  apply: boolean;
  help: boolean;
  vaults: string[];
  operatorPasswordFile?: string;
}

export function rootApplyRefusal(platform:string,uid:number|undefined):string|undefined{
  return platform!=='linux'||uid!==0?"--apply requires root on Linux. No database rows or files were changed.":undefined;
}

const HELP_TEXT = [
  "tsx services/box/bin/erase-person.ts <who> [--vault <path> ...] [--apply] [--operator-password-file <absolute-path>] [--help]",
  "",
  "Removes one member of this installation from every table in this database that names them,",
  "and — for every --vault given — from that vault's notes too. An apply uses the prepared financial",
  "journal and requires the keeper to be stopped first. File removals remain if the database fails.",
  "",
  "  <who>          The person: their id in the register, an old chat handle, or an email address.",
  "  --vault <path> A vault to also check, on this filesystem. Repeatable. Without at least one,",
  "                 no vault is looked at at all, and the report says so.",
  "  --apply        Actually do it. Root on Linux only; prepared financial custody is required.",
  "                 Without this flag nothing is changed and you get a practice run.",
  "  --operator-password-file <path>  Required for a full dry run when no prepared financial",
  "                 database binding exists. The protected host-only",
  "                 file is read only for this command; it is never an application fallback.",
  "  --help         Show this message.",
  "",
  "Exit codes:",
  "  0   done (or, without --apply, a practice run that found nothing in the way).",
  "  1   refused, or stopped partway. Nothing further was changed. The message above says what to fix.",
].join("\n");

/** Refuses an unknown flag rather than ignoring it: on this command a misread flag could be the
 *  difference between a practice run and an irreversible one. */
export function parseArgs(argv: readonly string[]): ParsedEraseArgs {
  let person: string | undefined;
  let apply = false;
  let help = false;
  const vaults: string[] = [];
  let operatorPasswordFile: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // `pnpm run <script> -- <args>` hands the bare separator through; it carries no meaning.
    if (arg === "--") continue;
    if (arg === "--apply") apply = true;
    else if (arg === "--help") help = true;
    else if (arg === "--vault") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("erase-person: --vault needs a path, e.g. --vault /srv/brain");
      }
      vaults.push(value);
      i += 1;
    } else if (arg === "--operator-password-file") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("erase-person: --operator-password-file needs an absolute path");
      if (!value.startsWith("/")) throw new Error("erase-person: --operator-password-file must be an absolute path");
      operatorPasswordFile = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(
        `erase-person: unknown flag "${arg}". Known flags: --vault · --apply · --operator-password-file · --help`,
      );
    } else if (person === undefined) person = arg;
    else {
      throw new Error(
        `erase-person: this command erases one person at a time, and "${person}" was already ` +
          `given. Run it again for "${arg}" separately.`,
      );
    }
  }

  return { ...(person !== undefined ? { person } : {}), apply, help, vaults, ...(operatorPasswordFile ? { operatorPasswordFile } : {}) };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exported so a test can drive it without spawning a process — migrate.ts's shape. */
export async function main(
  argv: readonly string[],
  deps: { db: Pool; out: (s: string) => void;journal?:HostFinancialJournal;nativeCustody?:BudgetNativeCustodyStore },
): Promise<number> {
  let args: ParsedEraseArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    deps.out(messageOf(err));
    return 1;
  }

  if (args.help) {
    deps.out(HELP_TEXT);
    return 0;
  }
  if (!args.person) {
    deps.out("erase-person: say who. \n\n" + HELP_TEXT);
    return 1;
  }

  if(args.apply&&!deps.journal?.prepared){
    deps.out("Prepared financial custody is not configured or available. No database rows or files were changed.");
    return 1;
  }

  let result;
  try {
    result = await runErase({ db: deps.db, person: args.person, vaults: args.vaults, apply: args.apply,journal:deps.journal,nativeCustody:deps.nativeCustody });
  } catch (err) {
    deps.out(
      "The erase stopped because the database could not be reached or answered unexpectedly. " +
        `Inspect the database and any vault files before deciding what to do next: ${messageOf(err)}`,
    );
    return 1;
  }

  deps.out(renderRunEraseReport(result));
  return result.dbReport.refusals.length > 0 || result.vaultError !== undefined || result.journalWarning!==undefined || result.nativeCleanup?.status!=='complete'&&result.nativeCleanup!==undefined || result.transactionOutcome==='unknown' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let db:Pool|undefined,journal:HostFinancialJournal|undefined,nativeCustody:BudgetNativeCustodyStore|undefined;
  let earlyExitCode:number|undefined;
  const args=process.argv.slice(2);
  let parsed:ParsedEraseArgs;
  try { parsed=parseArgs(args); }
  catch(err) { process.stdout.write(messageOf(err)+"\n"); process.exit(1); }
  const apply=args.includes('--apply')&&!args.includes('--help');
  const rootRefusal=apply?rootApplyRefusal(process.platform,process.getuid?.()):undefined;
  if(rootRefusal){
    process.stdout.write(rootRefusal+"\n");process.exit(1);
  }
  try{
    if(parsed.help){
      process.exitCode=await main(args,{db:{} as Pool,out:(s)=>process.stdout.write(s+"\n")});
    }else{
      const {loadKeeperConfig,keeperFinancialPool}=await import('../../keeper/lib/config.js');
      const {openConfiguredNativeCustody}=await import('../../keeper/lib/budget-native-cleanup.js');
      const {HostFinancialJournal}=await import('../../keeper/lib/financial-journal.js');
      const {operatorPoolFromFile}=await import('../lib/db.js');
      const config=loadKeeperConfig();
      if(config.budgetFinancial){
        if(apply)journal=HostFinancialJournal.openExisting(config.budgetFinancial.directory,{requirePrepared:true});
        if(apply)nativeCustody=openConfiguredNativeCustody(config.budgetNative?.directory);
        db=keeperFinancialPool(config)!;
        if(!db)throw new Error('configured financial database credential is unavailable');
      }else{
        if(apply){
          earlyExitCode=await main(args,{db:{} as Pool,out:(s)=>process.stdout.write(s+"\n")});
        }else{
          const operatorPath=parsed.operatorPasswordFile;
          if(!operatorPath)throw new Error('No prepared financial database binding exists. Supply --operator-password-file <absolute-path> for explicit offline database access.');
          db=await operatorPoolFromFile(operatorPath,config.db);
        }
      }
    }
    if(!parsed.help)process.exitCode=earlyExitCode??await main(args, { db:db!,journal,nativeCustody,out: (s) => process.stdout.write(s + "\n") });
  }
  catch(err){process.stdout.write(messageOf(err)+"\n");process.exitCode=1;}
  finally{
    try{await nativeCustody?.drainForShutdown();nativeCustody?.close();}catch(err){process.stdout.write(`Native custody needs inspection: ${messageOf(err)}\n`);process.exitCode=1;}
    try{journal?.close();}catch(err){process.stdout.write(`Financial custody needs inspection: ${messageOf(err)}\n`);process.exitCode=1;}
    await db?.end().catch(()=>undefined);
  }
}
