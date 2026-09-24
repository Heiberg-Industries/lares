import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { stateRoot } from "./state-paths.js";

export type NetworkConfig = {
  /** The owner's own profile — used to direction-classify LinkedIn messages. */
  ownLinkedInUrl: string;
  /** The owner's own display name — used to direction-classify Meta DM messages. */
  ownMetaName: string;
  /** Mounted NAS directory for `pnpm network backup`. Null = backup disabled. */
  nasBackupPath: string | null;
  /** Base URL of the self-hosted Twenty CRM instance. Null = Twenty sync disabled. */
  twentyBaseUrl: string | null;
  /** API key override for tests/dev. Real key belongs in the macOS Keychain. */
  twentyApiKey: string | null;
  /** Slack channel for the weekly digest, e.g. "#operations". Null = digest disabled. */
  digestSlackChannel: string | null;
  /** Token override for tests/dev. The real bot token belongs in the macOS Keychain. */
  slackBotToken: string | null;
  /**
   * Token override for tests/dev. The real Slack USER token (ORB-149 D1) belongs in the
   * macOS Keychain, service SLACK_USER_KEYCHAIN_SERVICE — distinct from `slackBotToken`
   * above (the digest's bot token). A user token is required to read The owner's DMs and
   * private channels at all; Slack enforces that a bot token cannot.
   */
  slackUserToken: string | null;
  /** Member Brain vault root (the Obsidian vault). Null = brain-notes disabled. */
  brainVaultPath: string | null;
  /** Canonical user id (identity registry) of the person whose network this is — stamped as
   *  `owner:` on every derived Brain note so the vault's scope filter shows them to that person.
   *  One importer per member. Null = brain-notes refuses to run. */
  brainOwnerUserId: string | null;
  /** The owner's own local contact id — excluded from Twenty matching (the owner is not a CRM record). */
  selfContactId: number | null;
};

const DEFAULTS: NetworkConfig = {
  ownLinkedInUrl: "",
  ownMetaName: "",
  nasBackupPath: null,
  twentyBaseUrl: null,
  twentyApiKey: null,
  digestSlackChannel: null,
  slackBotToken: null,
  slackUserToken: null,
  brainVaultPath: null,
  brainOwnerUserId: null,
  selfContactId: null,
};

export const CONFIG_PATH = join(stateRoot(), "config.json");

export function loadConfig(path: string = CONFIG_PATH): NetworkConfig {
  if (!existsSync(path)) return { ...DEFAULTS };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return { ...DEFAULTS, ...raw };
}

export const TWENTY_KEYCHAIN_SERVICE = process.env.LARES_TWENTY_KEYCHAIN_SERVICE || "lares-network-twenty";
// Existing installations can retain their current Keychain service labels through
// explicit launch-environment overrides; no secret copying is required.
export const SLACK_KEYCHAIN_SERVICE = process.env.LARES_SLACK_KEYCHAIN_SERVICE || "lares-network-slack";
// ORB-149 D1: one Slack USER token (xoxp-), two stores — this is the Mac half. The importer
// runs on the Mac (see docs/runbooks/slack-user-token.md for why: the box replica is
// wholesale-replaced on every push, so a box-side importer's writes would be destroyed).
// The box half (eve-saga's live obligation reads) is a SEPARATE store — oauth_tokens,
// provider='slack' — not this one; see that runbook for why rotation touches both.
export const SLACK_USER_KEYCHAIN_SERVICE = process.env.LARES_SLACK_USER_KEYCHAIN_SERVICE || "lares-network-slack-user";

function readKeychain(service: string): string {
  return execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
  }).trim();
}

/** Config override (tests/dev) → macOS Keychain. Throws with setup instructions when absent. */
export function resolveTwentyApiKey(config: NetworkConfig, keychainReader: () => string = () => readKeychain(TWENTY_KEYCHAIN_SERVICE)): string {
  if (config.twentyApiKey) return config.twentyApiKey;
  try {
    const key = keychainReader();
    if (key) return key;
  } catch {
    /* fall through to the instruction error */
  }
  throw new Error(
    `No Twenty API key found. Store it once with:\n` +
      `  security add-generic-password -s ${TWENTY_KEYCHAIN_SERVICE} -a $USER -w <api-key>\n` +
      `(create the key in Twenty → Settings → API & Webhooks)`,
  );
}

/** Config override (tests/dev) → macOS Keychain. Throws with setup instructions when absent. */
export function resolveSlackToken(config: NetworkConfig, keychainReader: () => string = () => readKeychain(SLACK_KEYCHAIN_SERVICE)): string {
  if (config.slackBotToken) return config.slackBotToken;
  try {
    const token = keychainReader();
    if (token) return token;
  } catch {
    /* fall through to the instruction error */
  }
  throw new Error(
    `No Slack bot token found. Use your configured bot token (Slack app → OAuth & Permissions):\n` +
      `  security add-generic-password -s ${SLACK_KEYCHAIN_SERVICE} -a $USER -w <xoxb-token>`,
  );
}

/**
 * Config override (tests/dev) → macOS Keychain. Throws with setup instructions when absent —
 * never silently no-ops without a token (ORB-149 binding constraint). See
 * docs/runbooks/slack-user-token.md for the full enrolment flow (The owner's OAuth install is a
 * human step this cannot perform).
 */
export function resolveSlackUserToken(config: NetworkConfig, keychainReader: () => string = () => readKeychain(SLACK_USER_KEYCHAIN_SERVICE)): string {
  if (config.slackUserToken) return config.slackUserToken;
  try {
    const token = keychainReader();
    if (token) return token;
  } catch {
    /* fall through to the instruction error */
  }
  throw new Error(
    `No Slack USER token found (needed to read The owner's DMs/private channels — a bot token can't). ` +
      `Complete the OAuth install in docs/runbooks/slack-user-token.md, then:\n` +
      `  security add-generic-password -s ${SLACK_USER_KEYCHAIN_SERVICE} -a $USER -w <xoxp-token>`,
  );
}
