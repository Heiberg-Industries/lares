import { describe, it, expect, vi } from "vitest";
vi.mock("../lib/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import type { ScheduleRunRow } from "@lares/agent-kit/schedule-heartbeat";
import { VOICE_LEARN_SKIPS } from "@lares/agent-kit/voice-learn-outcome";
import { relearnStatus, RELEARN_NOT_PICKED_UP_MS, RELEARN_STALE_MS, type RelearnFacts } from "../lib/voice";

// Every outcome the voice-learn schedule can record, and the plain words the page shows for it.
const NOW = new Date("2026-11-27T12:00:00Z");
const TZ = "UTC";
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const AGENT = { name: "example-agent", displayName: "Example Agent", voiceLearnOn: true };
const run = (state: ScheduleRunRow["state"], extra: Partial<ScheduleRunRow> = {}): ScheduleRunRow => ({
  job: `${extra.agent ?? "example-agent"}/voice-learn`, agent: "example-agent", state, reason: "", detail: "", counts: {},
  startedAt: ago(60_000), updatedAt: ago(60_000), ...extra,
});
const facts = (f: Partial<RelearnFacts>): RelearnFacts => ({ requestedAt: null, runs: [], agents: [AGENT], mailboxes: [], ...f });
const view = (f: Partial<RelearnFacts>) => relearnStatus(facts(f), NOW, TZ);

describe("relearnStatus", () => {
  it("nothing asked, nothing recorded: nothing to show", () => {
    expect(view({})).toBeNull();
  });

  it("requested, then waiting once it has not been picked up for a while", () => {
    expect(view({ requestedAt: ago(10_000) })).toMatchObject({ state: "requested", active: true });
    expect(view({ requestedAt: ago(RELEARN_NOT_PICKED_UP_MS + 1) })).toMatchObject({
      state: "waiting", why: "Example Agent has not picked this up yet. It may be stopped.", fix: { href: "/agents/example-agent" }, active: true,
    });
  });

  it("running, and a run that went quiet for hours reads as stopped, not running for ever", () => {
    expect(view({ runs: [run("running")] })).toMatchObject({ state: "running", active: true });
    expect(view({ runs: [run("running", { startedAt: ago(RELEARN_STALE_MS + 1), updatedAt: ago(RELEARN_STALE_MS + 1) })] })).toMatchObject({ state: "failed", active: false });
  });

  it("a request made during a run reads as covered by that run", () => {
    expect(view({ runs: [run("skipped", { reason: VOICE_LEARN_SKIPS.alreadyRunning, startedAt: null })] })).toMatchObject({
      state: "running", why: "Already learning. Your request is covered by the run that is going.", active: true,
    });
  });

  it("finished, with when and the counts", () => {
    expect(view({ runs: [run("finished", { counts: { kept: 1, dropped: 0 } })] })).toEqual({
      state: "finished", when: "today at 11:59", why: "Kept 1 email as examples, left out 0.", active: false,
    });
    expect(view({ runs: [run("finished", { counts: { kept: 2, dropped: 1, failed: 1 }, updatedAt: new Date("2026-11-20T08:05:00Z") })] })).toMatchObject({
      when: "on 2026-11-20 at 08:05", why: "Kept 2 emails as examples, left out 1. 1 mailbox failed.",
    });
  });

  it("failed, with why", () => {
    expect(view({ runs: [run("failed", { detail: "gateway 500" })] })).toMatchObject({ state: "failed", why: "The error was: gateway 500", active: false });
  });

  it("switched off now: said before anyone presses, with a link to the switch; polls only while a request waits", () => {
    const off = { ...AGENT, voiceLearnOn: false };
    expect(view({ agents: [off] })).toMatchObject({ state: "skipped", fix: { href: "/agents/example-agent/edit", label: "Switch it on in Edit agent" }, active: false });
    expect(view({ agents: [off], requestedAt: ago(1_000) })).toMatchObject({ state: "skipped", active: true });
    expect(view({ agents: [off], requestedAt: ago(1_000) })!.why).toContain("Your request runs once it is switched on.");
  });

  it("a skip recorded for a pending request says why it has not run, and keeps polling", () => {
    const skipped = run("skipped", { reason: VOICE_LEARN_SKIPS.schedulesOff, startedAt: null, updatedAt: ago(1_000) });
    expect(view({ requestedAt: ago(30_000), runs: [skipped] })).toMatchObject({
      state: "skipped", why: "Schedules are switched off on this server, so nothing runs on its own.", active: true,
    });
  });

  it("an older skip does not answer a newer request", () => {
    const skipped = run("skipped", { reason: VOICE_LEARN_SKIPS.noMailbox, startedAt: null, updatedAt: ago(60_000) });
    expect(view({ requestedAt: ago(10_000), runs: [skipped] })).toMatchObject({ state: "requested" });
  });

  it("each skip reason has its own words, and a link where something can be switched on or chosen", () => {
    const skip = (reason: string) => view({ runs: [run("skipped", { reason, startedAt: null })] });
    expect(skip(VOICE_LEARN_SKIPS.noMailbox)).toMatchObject({ why: "No mailbox chosen for Example Agent.", fix: { href: "/agents/example-agent" } });
    expect(skip(VOICE_LEARN_SKIPS.mailboxUnusable)).toMatchObject({ why: "The mailbox chosen for Example Agent cannot be used right now.", fix: { href: "/agents/example-agent" } });
    expect(skip(VOICE_LEARN_SKIPS.noCompareModel)).toMatchObject({ why: "No model for comparing texts is set up, so emails cannot be sorted for learning." });
    expect(skip(VOICE_LEARN_SKIPS.noCompareModel)!.fix).toBeUndefined();
    expect(skip(VOICE_LEARN_SKIPS.switchedOff)).toMatchObject({ why: "Voice Learn was switched off for Example Agent. It is on now: press Re-learn to run it." });
    expect(view({ agents: [AGENT, { ...AGENT, name: "other", displayName: "Other", voiceLearnOn: false }], runs: [run("skipped", { reason: VOICE_LEARN_SKIPS.switchedOff, agent: "other" })] }))
      .toMatchObject({ why: "Voice Learn is switched off for Other.", fix: { href: "/agents/other/edit" } });
    expect(view({ runs: [run("skipped", { reason: "something-new", detail: "A newer engine's reason." })] })).toMatchObject({ why: "A newer engine's reason." });
  });

  it("unreadable definitions: says nothing about switches rather than guessing", () => {
    expect(view({ agents: null })).toBeNull();
    expect(view({ agents: null, requestedAt: ago(1_000) })).toMatchObject({ state: "requested", why: "The agent starts it within a minute or two." });
  });

  it("names the agent only by its display name, never its technical name", () => {
    expect(JSON.stringify(view({ requestedAt: ago(RELEARN_NOT_PICKED_UP_MS + 1) }))).toContain("Example Agent has not");
  });
});

describe("relearnStatus with more than one chief-of-staff agent: one record each, combined", () => {
  const OTHER = { name: "other-agent", displayName: "Other Agent", voiceLearnOn: true };
  const both = (f: Partial<RelearnFacts>) => view({ agents: [AGENT, OTHER], ...f });

  it("a run that is going wins over the other agent's newer finished outcome", () => {
    const going = run("running", { agent: "other-agent", startedAt: ago(20 * 60_000), updatedAt: ago(20 * 60_000) });
    const done = run("finished", { counts: { kept: 3, dropped: 1 }, updatedAt: ago(1_000) });
    expect(both({ runs: [done, going] })).toMatchObject({ state: "running", active: true });
    expect(both({ runs: [going, done] })).toMatchObject({ state: "running", active: true });
  });

  it("a covering note from the agent whose run is going counts as going too", () => {
    const covering = run("skipped", { agent: "other-agent", reason: VOICE_LEARN_SKIPS.alreadyRunning, startedAt: null, updatedAt: ago(5_000) });
    const done = run("finished", { updatedAt: ago(1_000) });
    expect(both({ runs: [done, covering] })).toMatchObject({ state: "running", why: "Already learning. Your request is covered by the run that is going." });
  });

  it("a run silent for hours does not win: the newest outcome shows", () => {
    const silent = run("running", { agent: "other-agent", startedAt: ago(RELEARN_STALE_MS + 1), updatedAt: ago(RELEARN_STALE_MS + 1) });
    expect(both({ runs: [silent, run("finished", { counts: { kept: 2, dropped: 0 }, updatedAt: ago(1_000) })] })).toMatchObject({ state: "finished" });
  });

  it("otherwise the newest outcome, saying whose run it was by display name", () => {
    const older = run("finished", { counts: { kept: 1, dropped: 0 }, updatedAt: ago(60 * 60_000) });
    const newer = run("failed", { agent: "other-agent", detail: "gateway 500", updatedAt: ago(1_000) });
    expect(both({ runs: [older, newer] })).toMatchObject({ state: "failed", why: "Last run by Other Agent. The error was: gateway 500" });
    expect(both({ runs: [run("finished", { agent: "other-agent", counts: { kept: 4, dropped: 2 } })] })).toMatchObject({
      state: "finished", why: "Last run by Other Agent. Kept 4 emails as examples, left out 2.",
    });
    expect(JSON.stringify(both({ runs: [newer] }))).not.toContain("other-agent");
  });

  it("each skip names the agent whose record it is", () => {
    expect(both({ runs: [run("skipped", { agent: "other-agent", reason: VOICE_LEARN_SKIPS.noMailbox, startedAt: null })] })).toMatchObject({
      why: "No mailbox chosen for Other Agent.", fix: { href: "/agents/other-agent" },
    });
  });

  it("a request one agent cannot run (switched off) while another can: still requested, not skipped", () => {
    const offHere = { ...AGENT, voiceLearnOn: false };
    const skip = run("skipped", { reason: VOICE_LEARN_SKIPS.switchedOff, startedAt: null, updatedAt: ago(1_000) });
    expect(view({ agents: [offHere, OTHER], requestedAt: ago(10_000), runs: [skip] })).toMatchObject({
      state: "requested", why: "Other Agent starts it within a minute or two.", active: true,
    });
    expect(view({ agents: [offHere, OTHER], requestedAt: ago(RELEARN_NOT_PICKED_UP_MS + 1), runs: [skip] })).toMatchObject({
      state: "waiting", fix: { href: "/agents/other-agent" },
    });
  });

  it("switched off for every agent: names them all", () => {
    expect(view({ agents: [{ ...AGENT, voiceLearnOn: false }, { ...OTHER, voiceLearnOn: false }] })!.why)
      .toBe("Voice Learn is switched off for Example Agent and Other Agent, so it does not learn from Sent mail.");
  });

  it("with a single agent, a finished run does not say whose it was", () => {
    expect(view({ runs: [run("finished", { counts: { kept: 1, dropped: 0 } })] })!.why).toBe("Kept 1 email as examples, left out 0.");
  });
});
