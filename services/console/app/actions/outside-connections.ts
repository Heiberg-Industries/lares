"use server";
import { cookies } from "next/headers";
import { z } from "zod";
import { outsideToolSchema } from "@lares/agent-kit/definition";
import { memberAuditAddress, sessionMember } from "../../lib/auth";
import { keeper, KeeperRefusedError } from "../../lib/keeper-client";

const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const resultSchema = z.strictObject({
  name: nameSchema,
  definitionHash: hashSchema,
  accessRevision: z.number().int().positive(),
  connections: z.array(outsideToolSchema),
  applicationStatus: z.enum(["applied", "pending", "unavailable"]),
  appliedConnections: z.array(outsideToolSchema),
});
export type OutsideConnectionsState = z.infer<typeof resultSchema>;
export type OutsideConnectionsResult = { ok: true; result: OutsideConnectionsState } | { ok: false; message: string; current?: OutsideConnectionsState };

async function admitted(): Promise<{ sessionToken: string; actor: string }> {
  const sessionToken = (await cookies()).get("lares_session")?.value;
  const member = await sessionMember(sessionToken);
  if (!sessionToken || !member) throw new Error("Sign in again to manage this agent's connections.");
  const actor = await memberAuditAddress(member.id);
  if (!actor) throw new Error("Sign in again to manage this agent's connections.");
  return { sessionToken, actor };
}

export async function getOutsideConnections(name: string): Promise<OutsideConnectionsResult> {
  const { sessionToken, actor } = await admitted();
  if (!nameSchema.safeParse(name).success) throw new Error("Invalid agent name.");
  try {
    const result = resultSchema.parse(await keeper<unknown>("outside.connections.get", { sessionToken, name }, actor));
    return { ok: true, result };
  } catch (error) {
    if (error instanceof KeeperRefusedError) return { ok: false, message: "Current agent edit access is required. Refresh membership and try again." };
    return { ok: false, message: "Connections are unavailable. Refresh and try again." };
  }
}

export async function saveOutsideConnections(input: {
  name: string;
  expectedDefinitionHash: string;
  expectedAccessRevision: number;
  connections: unknown;
}): Promise<OutsideConnectionsResult> {
  const { sessionToken, actor } = await admitted();
  const parsed = z.strictObject({
    name: nameSchema,
    expectedDefinitionHash: hashSchema,
    expectedAccessRevision: z.number().int().positive(),
    connections: z.array(outsideToolSchema),
  }).safeParse(input);
  if (!parsed.success) throw new Error("Connection details are invalid.");
  try {
    const result = resultSchema.parse(await keeper<unknown>("outside.connections.save", { ...parsed.data, sessionToken }, actor));
    return { ok: true, result };
  } catch (error) {
    if (error instanceof KeeperRefusedError) return { ok: false, message: "The definition or access changed, or current agent edit access is missing. Refresh and review the connection again." };
    return { ok: false, message: "The connection change could not be confirmed. Refresh before trying again." };
  }
}

export async function applyOutsideConnections(input: { name: string; expectedDefinitionHash: string; expectedAccessRevision: number }): Promise<OutsideConnectionsResult> {
  const { sessionToken, actor } = await admitted();
  const parsed = z.strictObject({ name: nameSchema, expectedDefinitionHash: hashSchema,
    expectedAccessRevision: z.number().int().positive() }).safeParse(input);
  if (!parsed.success) throw new Error("Connection details are invalid.");
  try {
    const result = resultSchema.parse(await keeper<unknown>("outside.connections.apply", { ...parsed.data, sessionToken }, actor, { timeoutMs: 90_000 }));
    return { ok: true, result };
  } catch (error) {
    const current = await getOutsideConnections(input.name).catch(() => undefined);
    const confirmed = current?.ok ? current.result : undefined;
    if (error instanceof KeeperRefusedError) return { ok: false, message: confirmed?.applicationStatus === 'applied'
      ? "The refreshed state confirms these declarations are applied, although the Apply request was refused or interrupted."
      : confirmed?.applicationStatus === 'pending'
        ? "Apply was refused or interrupted, and the refreshed state still shows pending declarations. Review the current state before trying again."
        : "Apply was refused or interrupted. The current application state is unavailable; refresh before trying again.", ...(confirmed ? { current: confirmed } : {}) };
    return { ok: false, message: confirmed?.applicationStatus === 'applied'
      ? "The refreshed state confirms these declarations are applied, although the Apply request did not return normally."
      : confirmed?.applicationStatus === 'pending'
        ? "Apply did not return normally, and the refreshed state still shows pending declarations. Review the current state before trying again."
        : "Apply did not return normally and its application state could not be confirmed. Refresh before trying again.", ...(confirmed ? { current: confirmed } : {}) };
  }
}
