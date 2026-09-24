/**
 * Saga's adapter to the fleet's Signal Spine. Failure calls keep their original defaults and
 * fingerprint; callers may opt into lightweight activity events through `EmitSignalOptions`.
 *
 * Ported VERBATIM from `services/agent-runtime/lib/adapters/signal-emit.ts`: the wire
 * payload shape (`toSpinePayload` there), `POST {SIGNAL_SPINE_URL}/ingest` with
 * `Authorization: Bearer {SIGNAL_SPINE_TOKEN}`, the sha256 fingerprint composition
 * (`source|event|summary`), the 3s `AbortSignal.timeout`, and the silent-no-op-when-env-unset
 * / never-throws-into-caller contract.
 *
 * This wave's `emitSignal(event, summary, detail?, opts?)` is the thin single-caller variant of the
 * old file's `FailureSignal`/`makeSignalEmitter` factory: `source` is hardcoded
 * `"eve-saga"` (there is exactly one caller — this service — so no per-call `source` or
 * env-injection factory is needed).
 *
 * `SIGNAL_SPINE_TOKEN_FILE` preferred since ORB-178 (the box mounts it as a Docker secret);
 * the plain `SIGNAL_SPINE_TOKEN` env var stays supported until the box's `.env` line is
 * retired.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const SOURCE = "eve-saga";
const signalProject = (): string => process.env["SIGNAL_PROJECT"]?.trim() || "lares";

/** Memoizes only a SUCCESSFUL file read (the syscall worth avoiding on every emit once the
 *  secret is known good). A failed read is deliberately NOT cached: a persistent
 *  misconfiguration (missing mount, blank file) must keep failing loudly on every `emitSignal`
 *  call rather than going silent after the first one, and a file that gets fixed mid-process
 *  must be picked up on the very next call. The plain-env fallback stays a live `process.env`
 *  read on every call — it's free, and it only applies when `_FILE` is unset at all. */
let cachedFileToken: string | undefined;

/**
 * The signal-spine bearer token: `SIGNAL_SPINE_TOKEN_FILE` wins when set — trimmed file
 * content, or THROWS if the file cannot be read or is blank after trimming (fix round 1: a
 * blank file is a deploy error, not "unconfigured", mirroring atlas's `readSpineToken`; the
 * plain env var is a fallback ONLY when `_FILE` is unset, never a rescue for a broken FILE) —
 * else the plain `SIGNAL_SPINE_TOKEN` env var, else `undefined`. `spineToken()` itself can
 * throw; `emitSignal` is what upholds the never-throws contract, by catching it.
 */
function spineToken(): string | undefined {
  if (cachedFileToken !== undefined) return cachedFileToken;
  const filePath = process.env["SIGNAL_SPINE_TOKEN_FILE"];
  if (filePath !== undefined && filePath.trim() !== "") {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot read SIGNAL_SPINE_TOKEN_FILE at ${filePath}: ${reason}`);
    }
    const value = raw.trim();
    if (value === "") {
      throw new Error(`SIGNAL_SPINE_TOKEN_FILE at ${filePath} is empty`);
    }
    cachedFileToken = value;
    return cachedFileToken;
  }
  const plain = process.env["SIGNAL_SPINE_TOKEN"];
  return plain === undefined || plain.trim() === "" ? undefined : plain;
}

export interface EmitSignalOptions {
  /** The spine's rendering/retention class. This is distinct from `event`, the fingerprint discriminator. */
  kind?: "alert" | "event" | "report";
  type?: string;
  severity?: "error" | "warn" | "info";
  sections?: { label: string; value: string }[];
  links?: { label: string; url: string }[];
  target?: string;
  /** Catalogue discriminator, sent on the wire as `raw.key`. */
  key?: string;
  /** Stable dedupe material for reports whose title changes between passes. */
  fingerprintKey?: string;
}

function toSpinePayload(
  event: string,
  summary: string,
  detail: string | undefined,
  opts: EmitSignalOptions = {},
): unknown {
  const occurredAt = new Date().toISOString();
  const kind = opts.kind ?? "alert";
  return {
    source: SOURCE.slice(0, 200),
    project: signalProject(),
    kind,
    type: opts.type ?? "app-exception",
    severity: opts.severity ?? "error",
    title: summary.slice(0, 200),
    body: (detail ?? summary).slice(0, 4000),
    // Alerts/reports retain the legacy sha256(source|event|summary) dedupe key. Events append
    // a nonce because each occurrence must become its own grey line, never a repeat/thread.
    // the spine's own fingerprintOf, ported verbatim from the old adapter. Only summary is
    // hashed; detail goes to body unhashed — callers keep per-run ids out of summary.
    fingerprint: createHash("sha256")
      .update(`${SOURCE}|${event}|${opts.fingerprintKey ?? summary}${kind === "event" ? `|${randomUUID()}` : ""}`)
      .digest("hex"),
    url: null,
    occurredAt,
    sections: opts.sections,
    links: opts.links,
    target: opts.target,
    raw: opts.key === undefined ? undefined : { key: opts.key },
  };
}

/**
 * Emits a signal to the fleet's Signal Spine. `event` is only the stable fingerprint
 * discriminator; `opts.kind` is the wire-level alert/event/report class. With no options this
 * remains the legacy failure payload. Silent no-op when `SIGNAL_SPINE_URL`
 * or the resolved token is unset — a deploy that lands before the spine env does must be
 * a byte-for-byte no-op. Never throws or rejects into its caller: a hung or erroring spine
 * must not stall a workflow tick or an agent turn; failures are logged via `console.error`
 * only. This is why `spineToken()` is called from inside a `try` here rather than at the top
 * level — ~15 call sites (schedules' `catch` blocks, e.g. `agent/schedules/morning-brief.ts`)
 * call `emitSignal` specifically to report an already-caught failure; a configured-but-broken
 * `SIGNAL_SPINE_TOKEN_FILE` throwing OUT of this function would turn the failure-reporter
 * itself into an unhandled rejection (fix round 1). A 3s `AbortSignal` timeout bounds how long
 * a caller can be blocked once the spine is actually reachable.
 */
export function emitSignal(event: string, summary: string, detail?: string): Promise<void>;
export function emitSignal(event: string, summary: string, detail: string | undefined, opts: EmitSignalOptions): Promise<boolean>;
export async function emitSignal(
  event: string,
  summary: string,
  detail?: string,
  opts?: EmitSignalOptions,
): Promise<boolean | void> {
  const result = (accepted: boolean): boolean | undefined => opts === undefined ? undefined : accepted;
  const spineUrl = process.env["SIGNAL_SPINE_URL"];
  if (!spineUrl) return result(false);

  let token: string | undefined;
  try {
    token = spineToken();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[signal-emit] ${reason} — signal skipped`);
    return result(false);
  }
  if (!token) return result(false);

  const ingestUrl = `${spineUrl.replace(/\/+$/, "")}/ingest`;
  try {
    const res = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(toSpinePayload(event, summary, detail, opts)),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.error(`[signal-emit] spine responded ${res.status} ${res.statusText}`);
      return result(false);
    }
    return result(true);
  } catch (err) {
    console.error("[signal-emit] failed to POST to signal-spine:", err);
    return result(false);
  }
}
