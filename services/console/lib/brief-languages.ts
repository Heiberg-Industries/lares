/**
 * LAR-16-s3 — the brief languages the console offers, in a module with NO database import.
 *
 * `components/BriefLanguageControl.tsx` is a client component; anything it imports lands in the
 * browser bundle, and `lib/brief-settings.ts` reaches `pg` through `./db` — `next build` refuses
 * that ("Can't resolve 'fs' / 'net' / 'tls'"), and neither vitest nor tsc can see it. So the list
 * lives here, and `lib/brief-settings.ts` re-exports it for server-side callers.
 *
 * `BRIEF_LANGUAGES_MIRROR` MIRRORS, does not import, `services/chief-of-staff/lib/brief-settings.ts`'s
 * own `BRIEF_LANGUAGES` (ADR-0014 rule 12); `tests/engine-drift.test.ts` reads the agent side's
 * source as TEXT and fails the day the two lists disagree. The display name per code is this
 * side's own.
 */
export const BRIEF_LANGUAGES_MIRROR = [
  { code: "en", name: "English — default" },
  { code: "nb", name: "Norsk bokmål" },
  { code: "sv", name: "Svenska" },
  { code: "da", name: "Dansk" },
  { code: "fi", name: "Suomi" },
] as const;

export type BriefLanguageCode = (typeof BRIEF_LANGUAGES_MIRROR)[number]["code"];

export function isBriefLanguageCode(x: string): x is BriefLanguageCode {
  return (BRIEF_LANGUAGES_MIRROR as readonly { code: string }[]).some((l) => l.code === x);
}
