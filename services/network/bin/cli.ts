// Entry point for `pnpm network <sub> [args]` from the repo root. Runs on the Mac only.
// Every path the network commands read or write is anchored to the home directory
// (~/.lares/network.db, ~/.lares/config.json, ~/Library/…), never to the working directory.
import { buildProgram } from "./program.js";

buildProgram()
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
