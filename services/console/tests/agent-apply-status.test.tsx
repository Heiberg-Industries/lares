// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../app/actions/definition", () => ({ createAgent: vi.fn(), saveDefinition: vi.fn(), retireAgent: vi.fn(), deleteAgent: vi.fn(), applyConnections: vi.fn(),
  agentRuntime: vi.fn(), savedDefinition: vi.fn(), doorStatus: vi.fn(async () => ({ ok: true, result: [] })), listConversations: vi.fn(), startFreshConversation: vi.fn() }));
vi.mock("../app/actions/autonomy", () => ({ setAutonomy: vi.fn() }));
import { agentRuntime, applyConnections } from "../app/actions/definition";
import { DefinitionForm } from "../components/DefinitionForm";
import { modelAliases, startingPoints, takesEffect } from "../lib/builder";
import { agentRunStatus, ANSWERING_WHY, NOT_ANSWERING_MS, NOT_ANSWERING_WHY, STARTING_WHY } from "../lib/agent-apply-status";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const running = { pending: false, reason: null, running: true, healthy: true };
const notAnswering = { pending: false, reason: null, running: true, healthy: false };
const stopped = { pending: false, reason: null, running: false, healthy: null };

describe("where a restart stands", () => {
  it("Running while it restarts, then Finished with when, or Failed with why", () => {
    expect(agentRunStatus({ phase: "applying", label: "" }, stopped, 0, null)?.state).toBe("running");
    expect(agentRunStatus({ phase: "applied", at: new Date(2026, 10, 27, 14, 3).getTime() }, running, 0, null))
      .toEqual({ state: "finished", when: "at 14:03", why: ANSWERING_WHY, active: false });
    expect(agentRunStatus({ phase: "failed", at: 0, why: "Put back." }, running, 0, null)).toMatchObject({ state: "failed", why: "Put back.", active: false });
  });
  it("a start that is not answering yet is followed for ten minutes, then said to have failed", () => {
    expect(agentRunStatus({ phase: "applied", at: 0 }, notAnswering, 1_000, 0)).toEqual({ state: "running", why: STARTING_WHY, active: true });
    expect(agentRunStatus({ phase: "idle" }, notAnswering, NOT_ANSWERING_MS, 0)).toEqual({ state: "failed", why: NOT_ANSWERING_WHY, active: false });
  });
  it("nothing to say when nothing happened on this page and the agent simply runs", () => {
    expect(agentRunStatus({ phase: "idle" }, running, 0, null)).toBeNull();
    expect(agentRunStatus({ phase: "idle" }, stopped, 0, null)).toBeNull();
  });
});

describe("the edit page follows Apply and Start by itself", () => {
  const base = { owner: true, startingPoints: startingPoints(), aliases: modelAliases("example"),
    timing: Object.fromEntries(["name", "duties", "voice", "model", "grants", "skills", "schedules", "doors"].map((f) => [f, takesEffect(f)])),
    capacity: { ceiling: 6, activeCount: 3, approved: true, creationAvailable: true, canChange: true } };
  const initial = (runtime: object) => ({ definition: { ...base.startingPoints[0]!.definition, name: "example", model: "example-brain" },
    duties: "d", voice: "v", hash: "a".repeat(64), runtime, status: "valid" });
  const press = (label: string) => fireEvent.click([...document.querySelectorAll("button")].find((b) => b.textContent === label)!);

  it("Start: Running, then Finished and answering, with no reload instruction", async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(applyConnections).mockReturnValue(new Promise((r) => { answer = r; }) as never);
    render(<DefinitionForm {...base} initial={initial(stopped) as never} />);
    press("Start agent (applies saved definition)");
    await waitFor(() => expect(document.querySelector('[data-state="running"]')).not.toBeNull());
    expect(document.body.textContent).toContain("Starting the agent with the saved definition.");
    await act(async () => { answer({ ok: true, result: running }); });
    await waitFor(() => expect(document.querySelector('[data-state="finished"]')).not.toBeNull());
    expect(document.body.textContent).toContain(ANSWERING_WHY);
    expect(document.body.textContent).not.toContain("Reload to see");
    expect(document.body.textContent).not.toContain("Reload this agent");
  });

  it("Failed: says why, including that the earlier definition was put back", async () => {
    const why = "Apply failed. The agent is back on the last definition that had taken effect; the changes that were waiting for Apply were undone. Save them again before retrying. The previous definition is still running.";
    vi.mocked(applyConnections).mockResolvedValue({ ok: false, error: { message: why, state: "previous-running", outcomeMayBeUnknown: true } } as never);
    vi.mocked(agentRuntime).mockResolvedValue({ ok: true, result: running } as never);
    render(<DefinitionForm {...base} initial={initial({ pending: true, reason: "Changed doors" }) as never} />);
    press("Apply connection changes (restarts agent)");
    await waitFor(() => expect(document.querySelector('[data-state="failed"]')).not.toBeNull());
    expect(document.querySelector('[data-state="failed"]')!.textContent).toContain("back on the last definition that had taken effect");
    // What the agent runs now is read again, never assumed.
    await waitFor(() => expect(agentRuntime).toHaveBeenCalledWith("example"));
  });

  // Real time: the page asks again after its own five seconds (`useKeepFresh`).
  it("a start that is not answering yet is read again every few seconds until it answers", { timeout: 15_000 }, async () => {
    vi.mocked(applyConnections).mockResolvedValue({ ok: true, result: notAnswering } as never);
    vi.mocked(agentRuntime).mockResolvedValue({ ok: true, result: running } as never);
    render(<DefinitionForm {...base} initial={initial(stopped) as never} />);
    press("Start agent (applies saved definition)");
    await waitFor(() => expect(document.body.textContent).toContain(STARTING_WHY));
    expect(agentRuntime).not.toHaveBeenCalled();
    await waitFor(() => expect(agentRuntime).toHaveBeenCalledWith("example"), { timeout: 7_000 });
    await waitFor(() => expect(document.querySelector('[data-state="finished"]')).not.toBeNull());
    expect(document.body.textContent).toContain(ANSWERING_WHY);
  });

  it("a page opened while the agent is not answering yet follows it too, instead of asking for a reload", { timeout: 15_000 }, async () => {
    vi.mocked(agentRuntime).mockResolvedValue({ ok: true, result: running } as never);
    render(<DefinitionForm {...base} initial={initial(notAnswering) as never} />);
    expect(document.body.textContent).toContain(STARTING_WHY);
    expect(document.body.textContent).not.toContain("reload to check");
    await waitFor(() => expect(agentRuntime).toHaveBeenCalledWith("example"), { timeout: 7_000 });
    await waitFor(() => expect(document.body.textContent).toContain("Running. Saved connections are applied."));
  });
});
