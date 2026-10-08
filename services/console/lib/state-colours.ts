// One map, one vocabulary. Callers pass the state they actually have — they must not translate
// into some other domain's words on the way in. ConnectionsTable used to map live→done, which
// printed "done" for a credential; the fix was to delete that translation, not to patch the word.
//
// Unmapped states fall through to grey with their raw label. That is deliberate and correct for
// "unknown": the console does not mount host secrets, so it cannot tell a healthy host-custody
// credential from a broken one, and must not borrow "never" (a deliberate revoke on the autonomy
// dial) to say so.
export const STATE_COLOURS: Record<string, { c: string; label: string }> = {
  // workflow jobs
  idle: { c: "var(--mist)", label: "idle" },
  running: { c: "var(--run)", label: "running" },
  waiting: { c: "var(--warn)", label: "waiting" },
  done: { c: "var(--ok)", label: "done" },
  failed: { c: "var(--bad)", label: "failed" },
  // autonomy dial
  autonomous: { c: "var(--ok)", label: "autonomous" },
  gated: { c: "var(--warn)", label: "gated" },
  never: { c: "var(--bad)", label: "never" },
  // credentials (ConnectionRowDTO.status; "unknown" is deliberately absent)
  live: { c: "var(--ok)", label: "live" },
  partial: { c: "var(--warn)", label: "partial" },
  missing: { c: "var(--bad)", label: "missing" },
  'not-configured': { c: 'var(--mist)', label: 'Not configured' },
  'host-administration-required': { c: 'var(--warn)', label: 'Host administration required' },
  'pending-test': { c: 'var(--warn)', label: 'Pending test' },
  'test-failed': { c: 'var(--bad)', label: 'Test failed' },
  'pending-apply': { c: 'var(--warn)', label: 'Pending Apply' },
  applying: { c: 'var(--warn)', label: 'Applying' },
  disconnecting: { c: 'var(--warn)', label: 'Disconnecting locally' },
  applied: { c: 'var(--ok)', label: 'Applied' },
  disconnected: { c: 'var(--mist)', label: 'Disconnected locally' },
  'recovery-required': { c: 'var(--bad)', label: 'Recovery required' },
  // CRM mailbox sync (CrmChannelState). `paused` is red, not amber: the pause is deliberate and
  // protective, but the consequence — no mail reaching the CRM, no recovery without a human — is
  // identical to a failure, and amber would imply it heals itself.
  paused: { c: "var(--bad)", label: "paused" },
  "token expired": { c: "var(--bad)", label: "token expired" },
  failing: { c: "var(--bad)", label: "failing" },
  throttled: { c: "var(--warn)", label: "throttled" },
  "not yet synced": { c: "var(--warn)", label: "not yet synced" },
  syncing: { c: "var(--ok)", label: "syncing" },
};
