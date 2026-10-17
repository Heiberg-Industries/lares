"use server";
/**
 * Where each kind of message goes: the grid on the agent page saves here.
 *
 * The choice is the `delivery` map in the agent's definition, saved through the keeper like every
 * other definition change (`definition.save`: validated, written to the agent's folder, backed up).
 * Before it is saved, a routing that would send a brief to a door whose quiet hours cover the
 * brief's hour is refused with a plain sentence - the same check the hour and quiet-hours saves make.
 */
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { deliveryFindings } from "@lares/agent-kit/delivery";
import { verify } from "../../lib/auth";
import { keeper, KeeperRefusedError, KeeperUnavailableError } from "../../lib/keeper-client";
import { ownerId } from "../../lib/proactivity";
import { HOURLY_KINDS, briefConflicts, doorFor, loadConflictInputs, type RoutingFact } from "../../lib/delivery-check";
import type { DeliveryMap } from "../../lib/delivery";

export type DeliveryResult = { ok: true } | { ok: false; message: string };

export async function saveDelivery(input: { name: string; delivery: DeliveryMap }): Promise<DeliveryResult> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");

  const problems = deliveryFindings(input.delivery);
  if (problems.length > 0) return { ok: false, message: `${problems.join(". ")}.` };

  let saved: { definition: string; duties: string; voice: string };
  try {
    saved = await keeper<typeof saved>("definition.get", { name: input.name }, email);
  } catch {
    return { ok: false, message: "Could not read the agent's current settings. Reload and try again; nothing was changed." };
  }
  const definition = JSON.parse(saved.definition) as Record<string, unknown> & { doors?: RoutingFact["doors"]; channels?: string[]; delivery?: DeliveryMap };

  // Quiet hours: refuse a routing that would hold a brief back every day. Only the kinds whose door
  // actually changes are looked at, so an old, unrelated clash never blocks an unrelated edit.
  const data = await loadConflictInputs(ownerId(), email);
  if (data) {
    const doors = (definition.doors ?? (definition.channels ?? []).map((kind) => ({ kind, enabled: true })))
      .map((d) => ({ kind: d.kind, enabled: d.enabled }));
    const before: RoutingFact = { agent: input.name, delivery: definition.delivery, doors };
    const after: RoutingFact = { agent: input.name, delivery: input.delivery, doors };
    const changed = Object.entries(HOURLY_KINDS)
      .filter(([, kind]) => doorFor(before, kind) !== doorFor(after, kind))
      .map(([schedule]) => schedule);
    if (changed.length > 0) {
      const conflicts = briefConflicts({
        ...data, facts: [after], onlySchedules: changed,
      });
      if (conflicts.length > 0) return { ok: false, message: conflicts.join(" ") };
    }
  }

  try {
    await keeper("definition.save", {
      name: input.name,
      definition: { ...definition, delivery: input.delivery },
      duties: saved.duties,
      voice: saved.voice,
    }, email);
  } catch (error) {
    if (error instanceof KeeperRefusedError) {
      const detail = (error.findings ?? []).map((f) => f.message).join(" ");
      return { ok: false, message: detail || error.message };
    }
    if (error instanceof KeeperUnavailableError) {
      return { ok: false, message: error.outcomeMayBeUnknown
        ? "The agent's settings may or may not have been saved. Reload the page to see the current state."
        : error.message };
    }
    return { ok: false, message: "The settings could not be saved. Reload and try again." };
  }
  revalidatePath(`/agents/${input.name}`);
  return { ok: true };
}
