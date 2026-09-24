import {assertDoorAuthority,managedIdentity} from '@lares/agent-kit/door-authority';
/**
 * lib/telegram-credentials.ts — the bot token and webhook secret, read from disk at call time.
 *
 * Lifted out of `agent/channels/telegram.ts` (ORB-107) so that code which needs to SEND as
 * Marcel does not have to import the channel. The channel builds a `Gatekeeper`, a `Budget`
 * and a full dependency set at module scope; anything importing it for two credential
 * functions drags all of that along, and — the actual reason for this file — `lib/sveip-run.ts`
 * cannot import the channel at all, because the channel now imports IT (the `/sveip`
 * channel-level command). The channel re-exports `telegramCredentials` unchanged, so every
 * existing importer keeps working.
 *
 * Deliberately uncached and deliberately lazy: `eve build` evaluates these modules to compile
 * the agent, and a build — like CI — has no secrets at all. Anything read at module scope
 * fails the image build outright.
 *
 * Errors name the path and never the contents, matching `lib/gateway-provider.ts` and
 * eve-saga's `agent/channels/telegram.ts`.
 */
import { readFileSync } from "node:fs";

const DEFAULT_BOT_TOKEN_FILE = "/run/secrets/marcel-telegram-bot-token";
const DEFAULT_WEBHOOK_SECRET_TOKEN_FILE = "/run/secrets/marcel-eve-telegram-webhook-secret";

function readSecret(envVar: string, fallbackPath: string): string {
  if (managedIdentity() && !process.env[envVar]) throw new Error("Managed door credential is not configured");
  const path = process.env[envVar] ?? fallbackPath;
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`secret file not readable: ${path}`);
  }
  if (value.length === 0) throw new Error(`secret file is empty: ${path}`);
  return value;
}

/**
 * Credentials in the shape eve documents: `TelegramBotToken` and `TelegramWebhookSecretToken`
 * are each `string | (() => string | Promise<string>)`, so both are async functions here,
 * read at request time — never at module scope.
 */
export const telegramCredentials: {
  botToken: () => Promise<string>;
  webhookSecretToken: () => Promise<string>;
} = {
  botToken: async () => { await assertDoorAuthority("telegram"); return readSecret("TELEGRAM_BOT_TOKEN_FILE", DEFAULT_BOT_TOKEN_FILE); },
  webhookSecretToken: async () => { await assertDoorAuthority("telegram", true); return readSecret("TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE", DEFAULT_WEBHOOK_SECRET_TOKEN_FILE); },
};
