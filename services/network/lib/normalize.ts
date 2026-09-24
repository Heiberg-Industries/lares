export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/**
 * Phones normalize toward E.164. Norwegian default: a bare 8-digit number
 * gets +47. Anything under 8 digits is junk (short codes, internal numbers).
 */
export function normalizePhone(raw: string): string | null {
  let v = raw.replace(/[\s\-().]/g, "");
  if (v.startsWith("00")) v = "+" + v.slice(2);
  if (!v.startsWith("+")) {
    if (/^\d{8}$/.test(v)) v = "+47" + v;
    else if (/^\d{9,15}$/.test(v)) v = "+" + v;
    else return null;
  }
  return /^\+\d{8,15}$/.test(v) ? v : null;
}

/** Lowercase, fold diacritics (ø→o, å→a, é→e), collapse whitespace. */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Canonical form: https://www.linkedin.com/in/<slug> (lowercase, no query/trailing slash). */
export function normalizeLinkedInUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/in\/([^/]+)\/?$/);
    if (!m) return null;
    return `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}`;
  } catch {
    return null;
  }
}
