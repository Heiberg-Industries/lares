/**
 * Thin Slack poster for the weekly digest.
 *
 * Deliberate re-implementation of services/crm-notifier/lib/slack.ts —
 * cross-service imports are forbidden by convention (same reasoning as
 * lib/twenty.ts). Uses the same bot token as crm-notifier, read from the
 * macOS Keychain (see config.ts SLACK_KEYCHAIN_SERVICE).
 */

export type SlackMessage = { channel: string; text: string };

export async function postSlackMessage(
  opts: { token: string; fetchImpl?: typeof fetch },
  msg: SlackMessage,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(msg),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack chat.postMessage failed: ${data.error ?? "unknown"}`);
}
