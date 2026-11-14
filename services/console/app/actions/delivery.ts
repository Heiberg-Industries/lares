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
import { deliveryFindings, isTestBriefDoor } from "@lares/agent-kit/delivery";
import { verify } from "../../lib/auth";
import { keeper, KeeperRefusedError, KeeperUnavailableError } from "../../lib/keeper-client";
import { homeTz, ownerId } from "../../lib/proactivity";
import type { RuntimeState } from "../../lib/builder";
import { doorStateText, type DoorRow } from "../../lib/doors";
import {
  ASKED, TEST_BRIEF_REFUSALS, agentIsOwnersAlone, askForTestBrief, dndOn, latestTestBrief, testBriefRefusal, testBriefView,
  type TestBriefFacts, type TestBriefView,
} from "../../lib/test-brief";
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
    }, email, { timeoutMs: 90_000 }); // The same wait as every other definition save (app/actions/definition.ts).
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

// ── "Send a test brief now" ───────────────────────────────────────────────────────────────────
//
// One button per connected chat door on the agent's edit page. The owner check runs first, as on
// every other write here; then every refusal the owner can fix gets its sentence before anything is
// written (lib/test-brief.ts). The request row is all this writes: the agent's own morning-brief
// schedule picks it up, and Keeper's owner-job check still decides whether the brief may be paid.

export type TestBriefAskResult = { ok: true; message: string } | { ok: false; message: string };

export async function sendTestBrief(input: { name: string; door: string }): Promise<TestBriefAskResult> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(input.name) || !isTestBriefDoor(input.door)) {
    return { ok: false, message: TEST_BRIEF_REFUSALS.unavailable };
  }
  const door = input.door;
  let facts: TestBriefFacts;
  try {
    const [saved, doors] = await Promise.all([
      keeper<{ definition: string; runtime?: RuntimeState }>("definition.get", { name: input.name }, email),
      keeper<DoorRow[]>("door.status", { name: input.name }, email),
    ]);
    const definition = JSON.parse(saved.definition) as { role?: string; schedules?: Record<string, { on?: boolean }> };
    facts = {
      role: definition.role,
      running: saved.runtime?.running === true,
      pending: saved.runtime?.pending === true,
      morningBriefOn: definition.schedules?.["morning-brief"]?.on !== false,
      doorConnected: doorStateText(doors.find((d) => d.kind === door)) === "Connected",
      ownerOnly: await agentIsOwnersAlone(ownerId(), input.name),
    };
  } catch {
    return { ok: false, message: TEST_BRIEF_REFUSALS.unavailable };
  }
  const refused = testBriefRefusal(door, facts);
  if (refused) return { ok: false, message: refused };
  const asked = await askForTestBrief(input.name, ownerId(), door);
  return asked.ok ? { ok: true, message: ASKED } : asked;
}

export interface TestBriefStatus {
  view: TestBriefView | null;
  /** Do-not-disturb is on; the page says the test still goes out. */
  dnd: boolean;
}

/** The newest test-brief request for the agent, as one status line. Read only. */
export async function testBriefStatus(name: string): Promise<TestBriefStatus> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");
  try {
    const [row, dnd] = await Promise.all([latestTestBrief(name), dndOn(ownerId(), name)]);
    return { view: testBriefView(row, new Date(), homeTz()), dnd };
  } catch {
    return { view: null, dnd: false };
  }
}
