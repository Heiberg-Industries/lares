import { isValidTimeZone } from '@lares/agent-kit/owner-clock';

/** The agent environment settings an owner can set in the console instead of typing them into the
 * installation file. A fixed list on purpose: a key that is not here cannot be set from the console.
 * Each entry names the stored setting, the roles that read it, what is accepted and a plain sentence
 * about it. A stored value (even an empty one, "none on purpose") wins over the installation file. */
export type EnvironmentCheck = { value: string } | { error: string };
export interface ConsoleEnvironmentSetting {
    /** The environment variable the agent reads. */
    key: string;
    /** The row in the settings table. */
    setting: string;
    roles: readonly string[];
    /** The console section it is shown under. */
    section: string;
    label: string;
    description: string;
    /** Checks what was typed (already trimmed, never empty); returns the one form that is stored. */
    check(raw: string): EnvironmentCheck;
}
const bad = (error: string): EnvironmentCheck => ({ error });
const json = (raw: string): { parsed: unknown } | { error: string } => {
    try { return { parsed: JSON.parse(raw) as unknown }; } catch { return { error: 'That is not valid JSON.' }; }
};
// The same limits the keeper applies to every environment value in the installation file.
const fits = (value: string): EnvironmentCheck => value.length > 2048 ? bad('That is longer than 2048 characters.')
    : /[\r\n\0$]/.test(value) ? bad('That contains a character that is not allowed here (a "$", a NUL byte or a line break inside a value).')
        : { value };
const stringArray = (parsed: unknown): string[] | null => Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed as string[] : null;

// The rules below are the ones the agent applies when it reads the value (lib/crm-brands.ts,
// agent/tools/commercial_who_to_contact.ts, lib/brief-content.ts): a value that passes here is
// one the agent will actually use rather than warn about.
function crmBrands(raw: string): EnvironmentCheck {
    const j = json(raw);
    if ('error' in j) return j;
    const explain = 'Use a list like [{"id":"EXACT_TRACK_VALUE","description":"one line","closingSteps":["EXACT_STAGE_VALUE"]}].';
    if (!Array.isArray(j.parsed)) return bad(`That is not a list. ${explain}`);
    const seen = new Set<string>(), entries: object[] = [];
    for (const item of j.parsed) {
        const rec = item as { id?: unknown; description?: unknown; closingSteps?: unknown } | null;
        if (typeof rec?.id !== 'string' || rec.id.trim() === '') return bad(`An entry has no id. ${explain}`);
        if (seen.has(rec.id)) return bad(`The track ${rec.id} appears twice.`);
        seen.add(rec.id);
        if (rec.closingSteps !== undefined && (!Array.isArray(rec.closingSteps) || rec.closingSteps.some(step => typeof step !== 'string')))
            return bad(`closingSteps for ${rec.id} must be a list of exact stage values.`);
        entries.push({ id: rec.id, description: typeof rec.description === 'string' ? rec.description.trim() : '', ...(rec.closingSteps === undefined ? {} : { closingSteps: rec.closingSteps }) });
    }
    return fits(JSON.stringify(entries));
}
function commercialBrands(raw: string): EnvironmentCheck {
    const j = json(raw);
    if ('error' in j) return j;
    const brands = stringArray(j.parsed);
    if (!brands || brands.length === 0) return bad('Use a list of brand names like ["EXAMPLE_BRAND"]. To remove them all, leave the field empty.');
    return fits(JSON.stringify(brands));
}
function senderDomains(raw: string): EnvironmentCheck {
    const j = json(raw);
    if ('error' in j) return j;
    const domains = stringArray(j.parsed);
    if (!domains) return bad('Use a list of domains like ["authority.example"].');
    return fits(JSON.stringify(domains.map(d => d.trim().toLowerCase().replace(/^@/, '')).filter(d => d !== '')));
}
function articleArea(raw: string): EnvironmentCheck {
    const value = raw.toLowerCase();
    return value === 'shared' || value === 'private' ? { value } : bad('The article area must be shared or private.');
}
function twentyField(raw: string): EnvironmentCheck {
    return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw) ? { value: raw } : bad('A field name is letters and digits only, starting with a letter (for example orgNumber).');
}
function slackTarget(raw: string): EnvironmentCheck {
    return /^[#@A-Za-z0-9._-]{1,80}$/.test(raw) ? { value: raw } : bad('That does not look like a Slack user or channel id (for example U0123ABCD).');
}
function telegramBot(raw: string): EnvironmentCheck {
    const name = raw.replace(/^@/, '');
    return /^[A-Za-z0-9_]{5,32}$/.test(name) ? { value: name } : bad('A Telegram bot username is 5 to 32 letters, digits or underscores (the @ is optional).');
}
function consoleUrl(raw: string): EnvironmentCheck {
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error();
        return fits(raw);
    } catch { return bad('That must be an https address with no password, query or fragment, for example https://console.example.com.'); }
}
function homeZone(raw: string): EnvironmentCheck {
    return isValidTimeZone(raw) ? { value: raw } : bad('That is not a time zone name. Use one like Europe/Berlin or America/New_York.');
}
const CHIEF = ['chief-of-staff'] as const;
export const CONSOLE_ENVIRONMENT: readonly ConsoleEnvironmentSetting[] = [
    { key: 'CRM_BRANDS', setting: 'agent_env.crm_brands', roles: CHIEF, section: 'Business data', check: crmBrands,
        label: 'CRM tracks', description: 'A list that explains each CRM track to the agent and names the stages that close it: [{"id":"EXACT_TRACK_VALUE","description":"one line","closingSteps":["EXACT_STAGE_VALUE"]}].' },
    { key: 'COMMERCIAL_BRANDS', setting: 'agent_env.commercial_brands', roles: CHIEF, section: 'Business data', check: commercialBrands,
        label: 'Commercial brands', description: 'The brands the "who to contact" tool works on, as a list of names: ["EXAMPLE_BRAND"].' },
    { key: 'INSTITUTIONAL_SENDER_DOMAINS', setting: 'agent_env.institutional_sender_domains', roles: CHIEF, section: 'Business data', check: senderDomains,
        label: 'Authority sender domains', description: 'Domains whose mail counts as a due notice (tax authority, company register), as a list: ["authority.example"].' },
    { key: 'TWENTY_ORG_NUMBER_FIELD', setting: 'agent_env.twenty_org_number_field', roles: CHIEF, section: 'CRM', check: twentyField,
        label: 'Organisation number field', description: 'The name of the company field in your CRM that holds the organisation number. Empty means orgNumber.' },
    { key: 'LARES_ARTICLE_AREA', setting: 'agent_env.article_area', roles: CHIEF, section: 'Digest', check: articleArea,
        label: 'Where saved articles are filed', description: '"shared" lets the digest file saved articles into the shared area without asking each time (when the agent may write there); "private" files them privately.' },
    { key: 'DIGEST_SLACK_TARGET', setting: 'agent_env.digest_slack_target', roles: CHIEF, section: 'Digest', check: slackTarget,
        label: 'Slack target for the digest', description: 'The Slack user or channel id the digest is sent to. Empty means the first allowed Slack user.' },
    { key: 'TELEGRAM_BOT_USERNAME', setting: 'agent_env.telegram_bot_username', roles: CHIEF, section: 'Telegram', check: telegramBot,
        label: 'Telegram bot username', description: 'The username of your Telegram bot, so the agent can tell when it is mentioned in a group.' },
    { key: 'LARES_CONSOLE_URL', setting: 'agent_env.console_url', roles: CHIEF, section: 'Console address', check: consoleUrl,
        label: 'Console address', description: 'Where you open the console, for example https://console.example.com. A Telegram approval card too long for one message links to it.' },
    { key: 'OWNER_HOME_TZ', setting: 'agent_env.owner_home_tz', roles: CHIEF, section: 'Owner time zone', check: homeZone,
        label: 'Home time zone', description: 'The time zone the agents use for your day, for example Europe/Berlin. The console itself keeps following the installation setting.' },
];
export const CONSOLE_ENVIRONMENT_BY_KEY: ReadonlyMap<string, ConsoleEnvironmentSetting> = new Map(CONSOLE_ENVIRONMENT.map(s => [s.key, s]));
