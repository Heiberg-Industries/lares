import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Set LARES_HOME to keep using an existing state directory during an upgrade.
 * Never discover another application's directory or silently move its data. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LARES_HOME;
  if (configured !== undefined) {
    if (!configured || !isAbsolute(configured)) throw new Error("LARES_HOME must be an absolute directory path");
    return configured;
  }
  return join(homedir(), ".lares");
}
