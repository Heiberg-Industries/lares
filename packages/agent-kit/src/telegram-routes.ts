/**
 * lib/telegram-routes.ts — the two webhook paths, in a module that imports nothing (ORB-111).
 *
 * Both the front door (`agent/channels/telegram-webhook.ts`) and the Telegram channel itself
 * (`agent/channels/telegram.ts`) need these, and each already imports from the other — the front
 * door needs the channel's credentials, the channel needs its own inner path. Holding the
 * constants here breaks that cycle outright rather than relying on ES-module hoisting to make it
 * work, which is the kind of thing that holds in `tsx` and then surprises you inside a rollup
 * bundle.
 *
 * The PUBLIC path is the URL Telegram has always posted to and must not change: changing it would
 * mean a setWebhook call, a window where updates go nowhere, and a rollback that needs a second
 * one.
 */

/** Where Telegram posts. Owned by the front door. Matches eve's own default, which is what the
 *  channel used before the front door existed — so the registered webhook URL is unchanged. */
export const TELEGRAM_PUBLIC_ROUTE = "/eve/v1/telegram";

/** Where eve's own Telegram channel listens, behind the front door. */
export const TELEGRAM_INNER_ROUTE = "/eve/v1/telegram-inner";
