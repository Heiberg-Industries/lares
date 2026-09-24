import { createConnection } from "node:net";

// The console's only write path to the box (installer spec Part 3; ADR-0015 rule 2).
// It has no Docker, /srv, or /etc access of its own: the mounted keeper socket is its
// authority boundary. `actor` comes from the console's verified owner session and is
// recorded by the keeper. A keeper outage is never the same thing as an empty result.

const DEFAULT_SOCKET = "/run/lares/keeper.sock";
const DEFAULT_TIMEOUT_MS = 10_000;
// Keep this aligned with services/keeper/lib/socket-server.ts. The newline delimiter is
// deliberately excluded, because the keeper caps the JSON line itself.
const MAX_MESSAGE_BYTES = 256 * 1024;

export type KeeperFinding = { check: string; message: string };

export class KeeperUnavailableError extends Error {
  readonly outcomeMayBeUnknown: boolean;

  constructor(message: string, outcomeMayBeUnknown = false) {
    super(message);
    this.name = "KeeperUnavailableError";
    this.outcomeMayBeUnknown = outcomeMayBeUnknown;
  }
}

export class KeeperRefusedError extends Error {
  readonly findings?: KeeperFinding[];

  constructor(message: string, findings?: KeeperFinding[]) {
    super(message);
    this.name = "KeeperRefusedError";
    this.findings = findings;
  }
}

export interface KeeperOptions {
  timeoutMs?: number;
}

type KeeperResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; findings?: KeeperFinding[] };

function unavailableAfterSend(reason: string): KeeperUnavailableError {
  return new KeeperUnavailableError(`${reason}; the action outcome may be unknown`, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findings(value: unknown): KeeperFinding[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(finding => isRecord(finding)
    && typeof finding.check === "string" && typeof finding.message === "string")) return undefined;
  return value.map(finding => ({ check: finding.check as string, message: finding.message as string }));
}

function parseResponse(line: Buffer): KeeperResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString("utf8"));
  } catch {
    throw unavailableAfterSend("keeper returned an invalid response");
  }
  if (!isRecord(parsed)) throw unavailableAfterSend("keeper returned an invalid response");
  if (parsed.ok === true && Object.hasOwn(parsed, "result")) return { ok: true, result: parsed.result };
  if (parsed.ok === false && typeof parsed.error === "string") {
    if (Object.hasOwn(parsed, "findings") && findings(parsed.findings) === undefined) {
      throw unavailableAfterSend("keeper returned an invalid response");
    }
    return { ok: false, error: parsed.error, findings: findings(parsed.findings) };
  }
  throw unavailableAfterSend("keeper returned an invalid response");
}

/** Send one bounded newline-delimited JSON request to the local keeper. Never retries writes. */
export function keeper<T>(action: string, input: unknown, actor: string, opts: KeeperOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let serialized: string;
  try {
    serialized = JSON.stringify({ action, input, actor });
  } catch {
    return Promise.reject(new KeeperUnavailableError("keeper request could not be serialized; it was not transmitted"));
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) {
    return Promise.reject(new KeeperUnavailableError("keeper request too large; it was not transmitted"));
  }

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(process.env.LARES_KEEPER_SOCKET || DEFAULT_SOCKET);
    let settled = false;
    let transmitted = false;
    let received = Buffer.alloc(0);
    let timer: NodeJS.Timeout;

    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(result as T);
    };
    timer = setTimeout(() => finish(transmitted
      ? unavailableAfterSend("keeper did not respond before the timeout")
      : new KeeperUnavailableError("keeper could not be reached before the timeout")), timeoutMs);

    socket.once("connect", () => {
      transmitted = true;
      socket.write(`${serialized}\n`);
    });
    socket.on("data", chunk => {
      if (settled) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      // Retain no more than one permitted line. This also means an untrusted peer
      // cannot make the console buffer an arbitrary response before we reject it.
      const remaining = MAX_MESSAGE_BYTES + 1 - received.length;
      const useful = bytes.subarray(0, Math.max(0, remaining));
      const newlineInChunk = useful.indexOf(10);
      if (newlineInChunk < 0 && bytes.length > useful.length) {
        finish(unavailableAfterSend("keeper response too large"));
        return;
      }
      received = Buffer.concat([received, newlineInChunk >= 0 ? useful.subarray(0, newlineInChunk + 1) : useful]);
      const newline = received.indexOf(10);
      if (newline < 0) {
        if (received.length > MAX_MESSAGE_BYTES) finish(unavailableAfterSend("keeper response too large"));
        return;
      }
      if (newline > MAX_MESSAGE_BYTES) {
        finish(unavailableAfterSend("keeper response too large"));
        return;
      }
      try {
        const response = parseResponse(received.subarray(0, newline));
        if (response.ok) finish(undefined, response.result as T);
        else finish(new KeeperRefusedError(response.error, response.findings));
      } catch (error) {
        finish(error instanceof Error ? error : unavailableAfterSend("keeper returned an invalid response"));
      }
    });
    socket.once("error", () => {
      finish(transmitted
        ? unavailableAfterSend("keeper connection closed unexpectedly")
        : new KeeperUnavailableError("keeper could not be reached"));
    });
    socket.once("end", () => {
      finish(transmitted
        ? unavailableAfterSend("keeper connection closed before replying")
        : new KeeperUnavailableError("keeper could not be reached"));
    });
    socket.once("close", () => {
      finish(transmitted
        ? unavailableAfterSend("keeper connection closed before replying")
        : new KeeperUnavailableError("keeper could not be reached"));
    });
  });
}
