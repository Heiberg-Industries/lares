// The sentences the console uses for an outside tool server's key. Shared by the agent's page and the
// Integrations page so both say the same thing. No server code here: client components import it.
import type { OutsideToolEvidence } from "./outside-tools";

export function keyLine(needsKey: boolean, keys: OutsideToolEvidence["keys"] | undefined, tool: string): string {
  if (!needsKey) return "Needs a key: no";
  if (!keys) return "Needs a key: yes";
  if (!keys.available) return "Needs a key: yes. Key status unavailable: the keeper could not be asked.";
  const present = keys.value[tool];
  if (present === "custody") return "Needs a key: yes. Key kept in Lares.";
  if (present === "file") return "Needs a key: yes. Key file in place.";
  if (present === "missing") return "Needs a key: yes. Key file missing: the agent cannot use this tool until the key is placed on the server.";
  return "Needs a key: yes. Key status unavailable: the keeper could not check the key.";
}

/** Where a connection's tools work, in plain words. `all`: tools the agent may use; `free`: of those, the ones that run without asking. */
export function whereToolsWork(all: number, free: number): string {
  return `Where these tools work: web chat: all ${all}. Slack and Telegram private chats: only tools that run without asking (${free} of ${all}).`;
}

/** The choice put to the owner when a tool changes something and the agent's outside access is read-only. */
export function readOnlyChoiceWords(agent: string, tools: string[]): string {
  return `${agent}'s outside access is read-only, and ${tools.join(", ")} changes something. Everything else is saved. Leave ${tools.length === 1 ? "it" : "them"} out, or let ${agent} use ${tools.length === 1 ? "it" : "them"} only after asking you first?`;
}
