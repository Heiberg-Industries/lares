import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function validChatSessionId(value: string | null): value is string {
  return value !== null && SESSION_ID.test(value);
}

function cookieName(sessionId: string): string {
  return `lares_chat_${sessionId}`;
}

function signature(secret: string, member: string, agent: string, incarnation: string, sessionId: string): string {
  return createHmac("sha256", secret)
    .update(["lares-chat-v1", member.toLowerCase(), agent, incarnation, sessionId].join("\0"))
    .digest("base64url");
}

export function hasChatSessionCapability(
  cookieHeader: string | null,
  secret: string,
  member: string,
  agent: string,
  incarnation: string,
  sessionId: string,
): boolean {
  if (!validChatSessionId(sessionId)) return false;
  const name = cookieName(sessionId);
  const value = cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const expected = signature(secret, member, agent, incarnation, sessionId);
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export function chatSessionCapabilityCookie(
  request: Request,
  secret: string,
  member: string,
  agent: string,
  incarnation: string,
  sessionId: string,
): string {
  const value = signature(secret, member, agent, incarnation, sessionId);
  const path = `/api/chat/${agent}/eve/v1/session/${sessionId}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${cookieName(sessionId)}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}
