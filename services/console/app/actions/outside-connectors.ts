"use server";
// The owner's directory of outside connectors, as the console's pages use it: list, add (create, then
// check what the server is), rename (label only), check again, and remove. Each is a thin wrapper round the
// keeper's own connector actions, which decide who may do it. Removing also takes the connector off every agent
// that has it and erases the tokens Lares holds for it, through the actions the older screens used.
import { cookies } from "next/headers";
import { z } from "zod";
import { memberAuditAddress, requireConsoleMember, sessionMember } from "../../lib/auth";
import { keeper } from "../../lib/keeper-client";
import { keeperReason } from "../../lib/keeper-reason";
import { suggestConnectionName, uniqueConnectionName } from "../../lib/outside-connect-words";
import { foundSentence } from "../../lib/outside-connector-words";
import { listOutsideDiscoveryTargets, removeOutsideCredential } from "./outside-discovery";
import { connectRemoveDeclaration } from "./outside-connect";

const connectorSchema = z.object({
  id: z.string().uuid(), slug: z.string(), displayName: z.string(), url: z.string(), authKind: z.enum(["none", "token", "signin"]),
  description: z.string(), state: z.enum(["setup", "connected", "retired"]), createdBy: z.string(), createdAt: z.string(),
  probedAt: z.string().nullable(), toolCount: z.number().nullable(), catalogueAt: z.string().nullable(),
});
export type Connector = z.infer<typeof connectorSchema>;
export type ConnectorResult<T> = { ok: true; value: T } | { ok: false; message: string };

const uuid = z.string().uuid();
const TIMEOUT = { timeoutMs: 90_000 };

/** An error whose sentence is already for the owner to read. */
class Said extends Error {}

async function who(): Promise<{ sessionToken: string; actor: string }> {
  await requireConsoleMember();
  const sessionToken = (await cookies()).get("lares_session")?.value;
  const member = await sessionMember(sessionToken);
  const actor = member ? await memberAuditAddress(member.id) : undefined;
  if (!sessionToken || !member || !actor) throw new Said("Sign in again to manage outside tools.");
  return { sessionToken, actor };
}

async function run<T>(fallback: string, work: (w: { sessionToken: string; actor: string }) => Promise<T>): Promise<ConnectorResult<T>> {
  try { return { ok: true, value: await work(await who()) }; }
  catch (error) { return { ok: false, message: error instanceof Said ? error.message : keeperReason(error, fallback) }; }
}

async function list(w: { sessionToken: string; actor: string }): Promise<Connector[]> {
  const raw = await keeper<{ connectors?: unknown }>("outside.connector-list", { sessionToken: w.sessionToken }, w.actor);
  return z.array(connectorSchema).parse(raw.connectors);
}

/** The directory. Connections agents already had are adopted into it the first time it is read. */
export async function listConnectors(): Promise<ConnectorResult<Connector[]>> {
  await requireConsoleMember();
  return run("The outside tools could not be read. Reload the page to try again.", list);
}

/**
 * Add a connector in one press: save its name and address, then ask the server what it is. A failed check leaves the
 * saved connector in place and returns its id, so Try again continues at the check instead of creating it twice.
 */
export async function addConnector(input: unknown): Promise<{ ok: true; id: string; authKind: Connector["authKind"]; sentence: string } | { ok: false; message: string; id?: string }> {
  await requireConsoleMember();
  const parsed = z.strictObject({ name: z.string().trim().min(1).max(80), url: z.string().trim().min(1).max(2048), auth: z.enum(["automatic", "token"]), existingId: uuid.optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Give the connector a name and the server's full address." };
  const { name, url, existingId } = parsed.data;
  let id = existingId;
  const created = await run<string>("The connector could not be saved. Nothing was changed.", async (w) => {
    if (id) return id;
    const slug = uniqueConnectionName(suggestConnectionName(url) || suggestConnectionName(`https://${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`), (await list(w)).map(c => c.slug));
    if (!slug) throw new Said("Give the connector a name of letters and numbers.");
    const made = await keeper<{ connector: unknown }>("outside.connector-create", { sessionToken: w.sessionToken, slug, displayName: name, url, description: "" }, w.actor, TIMEOUT);
    return connectorSchema.parse(made.connector).id;
  });
  if (!created.ok) return created;
  id = created.value;
  const checked = await run<Connector["authKind"]>("Lares could not reach that server. Check the address, then try again.", async (w) => {
    const r = await keeper<{ authKind: unknown }>("outside.connector-probe", { sessionToken: w.sessionToken, id }, w.actor, TIMEOUT);
    return connectorSchema.shape.authKind.parse(r.authKind);
  });
  if (!checked.ok) return { ok: false, message: checked.message, id };
  return { ok: true, id, authKind: checked.value, sentence: foundSentence(checked.value) };
}

/** "Check it works": asks the server again what it is. It sends no token. */
export async function checkConnector(id: string): Promise<ConnectorResult<{ authKind: Connector["authKind"]; sentence: string }>> {
  await requireConsoleMember();
  if (!uuid.safeParse(id).success) return { ok: false, message: "That connector is not valid." };
  return run("Lares could not reach that server. Check the address, then try again.", async (w) => {
    const r = await keeper<{ authKind: unknown }>("outside.connector-probe", { sessionToken: w.sessionToken, id }, w.actor, TIMEOUT);
    const authKind = connectorSchema.shape.authKind.parse(r.authKind);
    return { authKind, sentence: foundSentence(authKind) };
  });
}

/** The label only. The technical name, every agent's declaration and every held token stay as they are. */
export async function renameConnector(input: { id: string; displayName: string }): Promise<ConnectorResult<null>> {
  await requireConsoleMember();
  const parsed = z.strictObject({ id: uuid, displayName: z.string().trim().min(1).max(80) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Give the connector a name of 1 to 80 characters." };
  return run("The connector could not be renamed.", async (w) => {
    await keeper("outside.connector-rename", { sessionToken: w.sessionToken, ...parsed.data }, w.actor);
    return null;
  });
}

/**
 * Remove: off every agent, the held tokens erased, then the directory row retired, in that order. A stop part way leaves the
 * rest still to do, so pressing Remove again continues from there.
 */
export async function removeConnector(id: string): Promise<ConnectorResult<{ agents: string[] }>> {
  await requireConsoleMember();
  if (!uuid.safeParse(id).success) return { ok: false, message: "That connector is not valid." };
  return run("The connector could not be removed. Press Remove again to continue.", async (w) => {
    const connector = (await list(w)).find(c => c.id === id);
    if (!connector) throw new Said("There is no such connector (it may have been removed).");
    const targets = (await listOutsideDiscoveryTargets()).filter(t => t.connectionName === connector.slug);
    const agents: string[] = [];
    for (const t of targets) {
      const gone = await connectRemoveDeclaration({ agent: t.agentName, name: connector.slug });
      if (!gone.ok) throw new Said(`${t.agentName}: ${gone.message}`);
      agents.push(t.agentName);
      const s = t.credentialStatus;
      if (s.accountId && s.generation !== null && s.state !== "revoked")
        await removeOutsideCredential({ accountId: s.accountId, agentName: t.agentName, connectionName: t.connectionName, expectedGeneration: s.generation });
    }
    await keeper("outside.connector-retire", { sessionToken: w.sessionToken, id }, w.actor, TIMEOUT);
    return { agents };
  });
}

/** Takes the connector off one agent: its declaration, then the token Lares holds for that agent. The directory row stays. */
export async function removeFromAgent(input: { agent: string; slug: string }): Promise<ConnectorResult<null>> {
  await requireConsoleMember();
  const parsed = z.strictObject({ agent: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/), slug: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "That agent or connector is not valid." };
  return run("The connector could not be taken off this agent.", async () => {
    const gone = await connectRemoveDeclaration({ agent: parsed.data.agent, name: parsed.data.slug });
    if (!gone.ok) throw new Said(gone.message);
    const t = (await listOutsideDiscoveryTargets()).find(x => x.agentName === parsed.data.agent && x.connectionName === parsed.data.slug);
    const s = t?.credentialStatus;
    if (t && s?.accountId && s.generation !== null && s.state !== "revoked")
      await removeOutsideCredential({ accountId: s.accountId, agentName: t.agentName, connectionName: t.connectionName, expectedGeneration: s.generation });
    return null;
  });
}
