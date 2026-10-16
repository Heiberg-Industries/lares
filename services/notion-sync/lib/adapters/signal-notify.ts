// The 👍 loop's human ping (Phase 3 plan T6, spec §18.6 pin): every notify()
// call in pull-sync.ts/apply-sync.ts (a proposal awaiting approval, an applied
// edit, a rejected edit reverted, a stale approval superseded, a stale freeze
// re-pinged) lands here. Under adapters/ for the same reason notion-client.ts
// and vault-writer.ts are: it holds the one piece of vendor knowledge (the
// spine's HTTP shape) the pure engines must not carry — PullSyncDeps/
// ApplySyncDeps just take a bare `notify: (message: string) => Promise<void>`.
//
// Real intake, matched against the fleet's OTHER signal-spine caller
// (services/agent-runtime/lib/adapters/signal-emit.ts, which itself cites the
// spine's own source rather than guessing) and double-checked against the
// spine's source directly (services/signal-spine/server.ts, lib/auth.ts,
// lib/signal.ts, lib/validate.ts, lib/seed.ts) — NOT the task brief's guessed
// `{text: message}` shape:
//   POST {url}/ingest                    (signal-spine/server.ts — not /signals)
//   Authorization: Bearer {token}        (signal-spine/lib/auth.ts tokenOk —
//     constant-time compare against the spine's INGEST_TOKEN)
//   Body: the full Signal (lib/signal.ts + lib/validate.ts signalSchema):
//     { source, project, type, severity, title, body, fingerprint, url,
//       occurredAt, raw? }
//   type is a CLOSED enum with no "just tell a human something" member
//   (app-exception | heartbeat-missed | service-down | backup-failed | disk |
//   data-quality | capability-gap | deploy-failed). type="app-exception" is
//   used here — the same type signal-emit.ts uses for failures (there always
//   at severity "error") — because the seed routing table
//   (signal-spine/lib/seed.ts) routes app-exception to Slack at EVERY
//   severity, "info" included, so a routine proposal ping and an actual
//   exception both surface in #lares-alerts, distinguished by severity/title
//   text alone. That is the best fit the closed enum offers; it is not a
//   perfect semantic match and is not meant to be one.
import { createHash } from "node:crypto";

export interface SignalNotifyOptions {
  url?: string;
  token?: string;
  /** Injectable for tests — defaults to the global fetch, mirrors notion-client.ts. */
  fetchImpl?: typeof globalThis.fetch;
}

export interface NotifyOptions {
  /** Names the message class for the spine's catalogue (`raw.key`, read by keyOf). */
  key?: string;
  severity?: "info" | "warn";
}

export type Notify = (message: string, opts?: NotifyOptions) => Promise<void>;

const SOURCE = "notion-sync";
const signalProject = (): string => process.env["SIGNAL_PROJECT"]?.trim() || "lares";
const TITLE_MAX = 200; // signalSchema: title <= 200 chars
const BODY_MAX = 4000; // signalSchema: body <= 4000 chars
const TIMEOUT_MS = 3000;

function toPayload(message: string, opts?: NotifyOptions): unknown {
  return {
    source: SOURCE,
    project: signalProject(),
    type: "app-exception",
    severity: opts?.severity ?? "info",
    title: message.slice(0, TITLE_MAX),
    body: message.slice(0, BODY_MAX),
    // Dedupe is the spine's job (spec 2026-09-04): a repeat threads under the first Slack post
    // and edits its counter. Nothing here suppresses; the fingerprint only has to be stable.
    fingerprint: createHash("sha256").update(`${SOURCE}|notify|${message}`).digest("hex"),
    url: null,
    occurredAt: new Date().toISOString(),
    raw: opts?.key ? { key: opts.key } : undefined,
  };
}

/**
 * Builds the notify function pull-sync.ts/apply-sync.ts inject.
 *
 * Unconfigured (no url or no token) falls back to console.log — the
 * deploy-ahead-of-env posture every other spine caller in this codebase takes
 * (signal-emit.ts's own NOOP) — so wiring this in before SIGNAL_SPINE_URL/
 * SIGNAL_SPINE_TOKEN land on the box is a byte-for-byte no-op, never a crash.
 *
 * A failed POST (network error or non-2xx) is console.error, never thrown:
 * notify is best-effort by spec (§18.6) — a down spine must never fail a sync
 * tick or make a completed write (an apply, a revert) look like a failure.
 */
export function makeSignalNotify(opts: SignalNotifyOptions): Notify {
  const { url, token } = opts;
  if (!url || !token) {
    return async (message: string): Promise<void> => {
      console.log(`notion-sync: [signal-spine not configured] ${message}`);
    };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const ingestUrl = `${url.replace(/\/+$/, "")}/ingest`;

  return async (message: string, notifyOpts?: NotifyOptions): Promise<void> => {
    try {
      const res = await fetchImpl(ingestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(toPayload(message, notifyOpts)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`notion-sync: notify: signal-spine responded ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error("notion-sync: notify: failed to POST to signal-spine:", err);
    }
  };
}
