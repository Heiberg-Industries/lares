// The sentences the console uses for an outside tool server's key. Shared by the agent's page and the
// Integrations page so both say the same thing. No server code here: client components import it.
import type { OutsideToolEvidence } from "./outside-tools";

export function keyLine(needsKey: boolean, keys: OutsideToolEvidence["keys"] | undefined, tool: string): string {
  if (!needsKey) return "Needs a key: no";
  if (!keys) return "Needs a key: yes";
  if (!keys.available) return "Needs a key: yes. Key status unavailable: the keeper could not be asked.";
  const present = keys.value[tool];
  if (present === true) return "Needs a key: yes. Key file in place.";
  if (present === false) return "Needs a key: yes. Key file missing: the agent cannot use this tool until the key is placed on the server.";
  return "Needs a key: yes. Key status unavailable: the keeper could not check the key file.";
}
