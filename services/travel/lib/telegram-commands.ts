/**
 * lib/telegram-commands.ts — the "/" command menu, registered with Telegram at every boot
 * (ORB-159).
 *
 * Old Marcel registered the menu on every start (`services/marcel/bin/marcel.ts:1030-1055`);
 * eve-marcel never ported the call, and when the bot identity was re-registered on 2026-08-17
 * the menu came back empty. A hand registration through the API (2026-08-24) restored it and
 * dies at the next re-registration. Registration belongs in boot code: `agent/instrumentation.ts`
 * calls this from `setup`, best-effort — a Telegram hiccup is reported, never thrown, because an
 * agent that will not start over a menu is worse than one with no menu.
 *
 * Two scopes, deliberately different: every group sees only `info` (the family-facing command);
 * the admin DM gets the toolkit. No `avbryt` — there is no wizard on eve to cancel (`nytur` is
 * conversational). Telegram overwrites on every call, so re-running at each boot is idempotent.
 *
 * The token is read only when called, never at module scope (`eve build` has no secrets), and
 * the call goes out through the injected sealed fetch (`@lares/agent-kit/telegram-fetch`) — a
 * bare fetch hangs against the egress seal. Error text names the method, never the URL: the
 * URL carries the token.
 */
export interface BotCommand {
  readonly command: string;
  readonly description: string;
}

/** What every linked family group sees when someone types "/". */
export const GROUP_COMMANDS: readonly BotCommand[] = [
  { command: "info", description: "Husets info: adresse, wifi, dørkode, nødnummer" },
];

/** The admin DM's toolkit — the exact set hand-registered on 2026-08-24. */
export const ADMIN_COMMANDS: readonly BotCommand[] = [
  { command: "nytur", description: "Opprett en ny tur" },
  { command: "sveip", description: "Sveip Reise-innboksen for bookinger på nytt" },
  { command: "info", description: "Husets info for turen" },
  { command: "marcel", description: "Skru Marcel av eller på (/marcel av | /marcel på)" },
];

export interface RegisterCommandMenusDeps {
  botToken(): Promise<string>;
  fetch: typeof fetch;
  /** `MARCEL_ADMIN_TELEGRAM_ID`. Telegram's `chat_id` is Integer or String: a numeric id goes
   *  out as a number, anything else verbatim. */
  adminChatId: string;
}

export interface RegisterCommandMenusResult {
  ok: boolean;
  error?: string;
}

const TELEGRAM_API = "https://api.telegram.org";

export async function registerCommandMenus(deps: RegisterCommandMenusDeps): Promise<RegisterCommandMenusResult> {
  try {
    const token = await deps.botToken();
    const url = `${TELEGRAM_API}/bot${token}/setMyCommands`;
    const chatId = /^-?\d+$/.test(deps.adminChatId) ? Number(deps.adminChatId) : deps.adminChatId;
    const menus: { commands: readonly BotCommand[]; scope: { type: string; chat_id?: number | string } }[] = [
      { commands: GROUP_COMMANDS, scope: { type: "all_group_chats" } },
      { commands: ADMIN_COMMANDS, scope: { type: "chat", chat_id: chatId } },
    ];
    for (const { commands, scope } of menus) {
      const res = await deps.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands, scope }),
      });
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!res.ok || payload.ok !== true) {
        const why = payload.description ? ` — ${payload.description}` : "";
        return { ok: false, error: `setMyCommands (${scope.type}) refused: HTTP ${res.status}${why}` };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `setMyCommands failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
