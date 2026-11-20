import { KeeperRefusedError } from "./keeper-client";

/**
 * The keeper's own reason for a refusal, in its words, for the owner to read. A refusal carries a
 * hand-written sentence (or a list of checks that failed); a console action that swallows it behind
 * "refresh and try again" leaves the owner with nothing to act on. Anything that is not a refusal
 * (a lost socket, a crash) has no reason the keeper chose to give, so it gets `fallback`.
 */
export function keeperReason(error: unknown, fallback: string): string {
  if (!(error instanceof KeeperRefusedError)) return fallback;
  const lines = (error.findings?.length ? error.findings.map(f => f.message) : [error.message])
    .map(line => line.replace(/^\[[a-z0-9-]+\]\s*/i, "").trim())
    .filter(Boolean);
  return lines.length ? lines.join(" ") : fallback;
}
