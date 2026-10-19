const PROBE = "http://x.invalid";

/**
 * Only a path on this console may be returned to after sign-in; anything else falls back to the home page.
 * Control characters and whitespace are refused outright: URL parsing silently strips tab, newline and
 * carriage return, which would turn "/<tab>/host" into the external address "//host".
 */
export function safeNext(raw: string | string[] | null | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return "/";
  if (/[\x00-\x20\x7f\\]/.test(v)) return "/";
  if (!/^\/(?!\/)/.test(v)) return "/";
  let u: URL;
  try {
    u = new URL(v, PROBE);
  } catch {
    return "/";
  }
  if (u.origin !== PROBE) return "/";
  const path = u.pathname + u.search + u.hash;
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  if (path.startsWith("/sign-in") || path.startsWith("/api/auth")) return "/";
  return path;
}

/** Defence in depth at each redirect: the target must stay on the console's own origin. */
export function sameOriginTarget(path: string, base: string | URL): URL {
  const target = new URL(path, base);
  return target.origin === new URL(base).origin ? target : new URL("/", base);
}
