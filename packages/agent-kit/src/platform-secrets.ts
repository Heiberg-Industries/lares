// The one declared home for the secret files that are NOT an integration with a vendor: the
// engine's own platform secrets and the chat doors' secrets. Integration secrets are generated
// from `integrations/installation.json` (see `connections.ts`); these are hand-declared here,
// because they belong to the engine and must survive any change to installation data.
//
// Pure data. No I/O, no credential reads. The keeper mounts these, the doors read them, and the
// integration-secret lint counts them as declared.

/** Platform secrets, keyed by the environment variable that points at the file. Value: file name. */
export const PLATFORM_SECRET_FILES = {
  LANGFUSE_KEY_FILE: 'langfuse-keys',
  EVE_ROUTE_PASSWORD_FILE: 'eve-route-password',
  TOKEN_ENC_KEY_FILE: 'token-enc-key',
} as const;

/** Fixed target names used by managed runtimes. google-token-key is the shared Google
 *  encryption-key mount; it is the same configured source when a legacy email door coexists. */
export const PLATFORM_FIXED_SECRET_FILES = ['runtime-control', 'database-password', 'google-token-key'] as const;

/** Per door kind: the environment variable that points at the secret file, and the file-name
 *  suffix the keeper mounts it under (`<agent>-<suffix>`). */
export const DOOR_SECRET_FILES = {
  slack: { SLACK_BOT_TOKEN_FILE: 'slack-token', SLACK_SIGNING_SECRET_FILE: 'slack-signing-secret' },
  telegram: { TELEGRAM_BOT_TOKEN_FILE: 'telegram-token', TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE: 'telegram-webhook-secret' },
} as const;

/** The default file names the Slack and Telegram door channels fall back to when the environment
 *  variable is unset. Declared here rather than renamed: an older box still mounts these names. */
export const LEGACY_DOOR_FALLBACKS = [
  'eve-slack-bot-token',
  'eve-slack-signing-secret',
  'eve-telegram-bot-token',
  'eve-telegram-webhook-secret',
] as const;

/** Every secret file name declared by this module. */
export function platformSecretNames(): string[] {
  return [
    ...Object.values(PLATFORM_SECRET_FILES),
    ...PLATFORM_FIXED_SECRET_FILES,
    ...Object.values(DOOR_SECRET_FILES).flatMap((files) => Object.values(files)),
    ...LEGACY_DOOR_FALLBACKS,
  ];
}
