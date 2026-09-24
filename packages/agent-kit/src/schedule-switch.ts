// A schedule reads the definition at its TICK (agent-definitions spec, Part 3), so a change
// reaches it at its next firing rather than at a restart — which is what makes "switch the
// evening brief off" a console click instead of a deploy.
//
// ANDed with EVE_SCHEDULES_LIVE, which stays exactly what it was: the box-level master switch
// that keeps a shadow agent dark. A definition must never be able to wake a schedule on a box
// that is deliberately silent (plan D6), so the env wins in the OFF direction only.
//
// SILENCE MEANS ON. Every schedule an image ships runs today on a live box; reading an
// un-edited definition as "all schedules off" would darken the whole fleet the moment this
// lands. The builder always writes an explicit entry, so silence only ever means "this
// definition predates that schedule".
import { scheduleGate } from "./schedule-gate.js";
import type { AgentDefinition } from "./definition.js";

export function scheduleEnabled(d: AgentDefinition, name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!scheduleGate(env)) return false;
  const entry = d.schedules[name];
  return entry === undefined ? true : entry.on;
}

// SILENCE MEANS OFF, for the one kind of schedule that cannot be given the benefit of the doubt.
//
// The rule above is right for a schedule that speaks or reads: the worst a wrong "on" costs is a
// message nobody asked for, and darkening the fleet on an un-edited definition would be worse. It
// is wrong for a schedule that DELETES. A definition written before such a schedule existed says
// nothing about it — and "nothing" must not be read as consent to start removing an owner's data
// on the night the image lands. A role template's `{ "on": false }` only reaches definitions
// GENERATED after that template; the definitions already sitting on a running box predate it.
//
// So this is the same switch with the benefit of the doubt removed: the box-level gate must be
// open AND the definition must say `on: true` in as many words. Its first user is
// `conversation-prune` (`services/chief-of-staff/agent/schedules/conversation-prune.ts`,
// ADR-0020 rule 3), and a schedule should only be moved onto it if a wrong "on" would destroy
// something — not merely because it is new.
export function scheduleExplicitlyEnabled(
  d: AgentDefinition, name: string, env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!scheduleGate(env)) return false;
  return d.schedules[name]?.on === true;
}
