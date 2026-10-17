/** Only a path on this console may be returned to after sign-in; anything else falls back to the home page. */
export function safeNext(raw: string | string[] | null | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return "/";
  if (!/^\/(?![/\\])/.test(v)) return "/";
  if (v.startsWith("/sign-in") || v.startsWith("/api/auth")) return "/";
  return v;
}
