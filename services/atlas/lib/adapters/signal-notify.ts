// services/atlas/lib/adapters/signal-notify.ts
// The signal-spine POST, pulled out of bin/atlas-sync.ts so it can be unit tested with an
// injected fetch — services/notion-sync/lib/adapters/signal-notify.ts is the prior art for
// the identical move in that sibling package. The bin script wires config and readers
// eagerly at import time (poolFromEnv, probeLocalStores — a live network call), so it can
// never itself be imported by a test; this adapter can.
//
// Task 15 (source-health findings are warn): every atlas signal went out as
// data-quality/info, and the spine's route table has no row for that pair — every atlas
// signal was silently dropped, which is how the first live tick's SOMA source-health alert
// was lost. `opts.key === "source-health"` is what upgrades severity to "warn"
// (data-quality/warn DOES have a route); anything else stays "info" and reaches the spine's
// v2 catch-all instead. Nothing else about the wire format changes.
import { createHash } from "node:crypto";

const signalProject = (): string => process.env["SIGNAL_PROJECT"]?.trim() || "lares";

export interface SignalNotifyOptions {
  url?: string;
  token?: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

export interface NotifyOptions {
  /**
   * Names the message class for the spine v2 description lookup (`raw.key`, resolved by
   * (source, type, key)). "source-health" is the one key this service sends today — a
   * source that could not be read, or one that just became readable again — and it is what
   * routes the message to severity "warn".
   */
  key?: string;
}

export type Notify = (message: string, opts?: NotifyOptions) => Promise<void>;

function severityFor(opts?: NotifyOptions): "warn" | "info" {
  return opts?.key === "source-health" ? "warn" : "info";
}

/**
 * Builds the notify function bin/atlas-sync.ts injects into TickDeps.
 *
 * Unconfigured (no url, or no token, including a blank string — the box's compose resolves
 * an absent .env line to `""`) falls back to console.log, never fetch: the
 * deploy-ahead-of-env posture notion-sync's own makeSignalNotify takes, so wiring this in
 * before SIGNAL_SPINE_URL/SIGNAL_SPINE_TOKEN(_FILE) land on the box delays the notification
 * rather than crashing the tick that produced it.
 *
 * A failed POST (network error or non-2xx) is console.error, never thrown: losing a message
 * must not lose the work a tick already did.
 */
export function makeSignalNotify(opts: SignalNotifyOptions): Notify {
  const { url, token } = opts;
  if (url === undefined || url.trim() === "" || token === undefined || token.trim() === "") {
    return async (message: string): Promise<void> => {
      console.log(`atlas: [signal-spine not configured] ${message}`);
    };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const ingestUrl = `${url.replace(/\/+$/, "")}/ingest`;

  return async (message: string, notifyOpts?: NotifyOptions): Promise<void> => {
    try {
      const res = await fetchImpl(ingestUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        // The spine's Signal shape (services/signal-spine/lib/signal.ts), not a shape of our
        // own — a 400 was what the first live tick got for inventing {source, kind, text}.
        //
        // The fingerprint hashes the MESSAGE, deliberately, copying notion-sync's reasoning:
        // a note whose source stays unreachable produces the identical sentence on every
        // tick, and hashing it collapses those into one Slack post per dedupe window instead
        // of a daily repeat. Source-health pings already fire only on TRANSITION, so this is
        // the second guard on the same failure mode, not the first.
        body: JSON.stringify({
          source: "atlas",
          project: signalProject(),
          type: "data-quality",
          severity: severityFor(notifyOpts),
          title: message.slice(0, 120),
          body: message,
          fingerprint: createHash("sha256").update(`atlas|notify|${message}`).digest("hex"),
          url: null,
          occurredAt: new Date().toISOString(),
          raw: notifyOpts?.key !== undefined ? { key: notifyOpts.key } : undefined,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`atlas: notify: signal-spine responded ${res.status}`);
    } catch (e) {
      console.error(`atlas: notify failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}
