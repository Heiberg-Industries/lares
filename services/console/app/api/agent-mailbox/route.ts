import { cookies } from "next/headers";
import { z } from "zod";
import { PgAgentMailboxStore } from "@lares/agent-kit/agent-mailbox-store";
import { withConsoleAdmission } from "../../../lib/admission-error";
import { sessionMember } from "../../../lib/auth";
import { pool } from "../../../lib/db";
import { accountStatusLabel, agentDefinitionFor, agentMailboxView, refusalSentence } from "../../../lib/agent-mailbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const failed = (code: string, status: number, message?: string) => response({ ok: false, code, ...(message ? { message } : {}) }, status);
const name = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
const request = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("choose"), name, accountId: z.string().trim().min(1).max(200), resourceBindingId: z.string().trim().min(1).max(200) }),
  z.strictObject({ operation: z.literal("confirm"), name }),
  z.strictObject({ operation: z.literal("clear"), name }),
]);
function sameOrigin(req: Request): boolean {
  try {
    const configured = process.env.CONSOLE_OAUTH_REDIRECT;
    const origin = configured ? new URL(configured).origin : process.env.NODE_ENV !== "production" ? new URL(req.url).origin : null;
    return !!origin && req.headers.get("origin") === origin;
  } catch { return false; }
}
async function input(req: Request): Promise<unknown> {
  if (new URL(req.url).search || req.headers.get("content-type")?.split(";")[0] !== "application/json" || !req.body) throw new Error("Invalid request");
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.length;
      if (length > 16_384) throw new Error("Invalid request");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const statusFor = (code: string) => code === "not-owner" ? 403 : code === "outcome-unknown" ? 503 : 409;

/** The owner's view of the agent's mailbox line. */
async function handleGET(req: Request): Promise<Response> {
  const member = await sessionMember((await cookies()).get("lares_session")?.value);
  if (!member) return failed("sign-in-required", 401);
  const parsed = name.safeParse(new URL(req.url).searchParams.get("name"));
  if (!parsed.success) return failed("invalid-request", 400);
  const definition = await agentDefinitionFor(parsed.data);
  if (!definition) return failed("definition-unavailable", 409, accountStatusLabel("definition-unavailable"));
  return response({ ok: true, view: await agentMailboxView(member, parsed.data, definition) });
}

/** Choose, confirm after a reconnect, or clear. Who and what are decided here, never by the page. */
async function handlePOST(req: Request): Promise<Response> {
  const member = await sessionMember((await cookies()).get("lares_session")?.value);
  if (!member) return failed("sign-in-required", 401);
  if (!sameOrigin(req)) return failed("origin-refused", 403);
  let parsed;
  try { parsed = request.safeParse(await input(req)); } catch { return failed("invalid-request", 400); }
  if (!parsed.success) return failed("invalid-request", 400);
  const command = parsed.data, store = new PgAgentMailboxStore(pool);
  try {
    if (command.operation === "clear") await store.clear(member.id, command.name);
    else {
      const definition = await agentDefinitionFor(command.name);
      if (!definition) return failed("definition-unavailable", 409, accountStatusLabel("definition-unavailable"));
      let pick = command.operation === "choose" ? { accountId: command.accountId, resourceBindingId: command.resourceBindingId } : undefined;
      if (!pick) {
        const binding = (await store.get(member.id, command.name)).binding;
        if (!binding) return failed("account-unavailable", 409, accountStatusLabel("account-unavailable"));
        pick = { accountId: binding.accountId, resourceBindingId: binding.resourceBindingId };
      }
      await store.set(member.id, command.name, pick, definition);
    }
    const definition = await agentDefinitionFor(command.name);
    if (!definition) return failed("outcome-unknown", 503);
    return response({ ok: true, view: await agentMailboxView(member, command.name, definition) });
  } catch (error) {
    const { code, sentence } = refusalSentence(error);
    return failed(code, statusFor(code), sentence);
  }
}

export const GET = withConsoleAdmission(handleGET);
export const POST = withConsoleAdmission(handlePOST);
