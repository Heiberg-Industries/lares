// @vitest-environment jsdom
import React, { useState } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, render } from "@testing-library/react";
import { RUN_STATES, RunStatus, runStateIsActive, type RunState } from "@lares/ui/patterns";
import { STATE_COLOURS } from "../lib/state-colours";
import { useKeepFresh } from "../lib/use-keep-fresh";

// The shared status part (packages/ui) and the shared "keep this up to date" hook.
describe("RunStatus", () => {
  it("says each state in a plain word, with a default sentence", () => {
    const html = renderToStaticMarkup(<RunStatus state="requested" />);
    expect(html).toContain('data-state="requested"');
    expect(html).toContain(">Requested<");
    expect(html).toContain("Asked for. It starts within a minute or two.");
    expect(html).toContain('role="status"');
  });

  it("finished with when; failed and skipped with why and the link that fixes it", () => {
    expect(renderToStaticMarkup(<RunStatus state="finished" when="today at 14:03" why="Kept 3." />)).toContain("Finished today at 14:03. Kept 3.");
    expect(renderToStaticMarkup(<RunStatus state="failed" why="The error was: x" />)).toContain(">The error was: x<");
    const skipped = renderToStaticMarkup(<RunStatus state="skipped" why="It is switched off." fix={{ href: "/agents/a/edit", label: "Switch it on" }} />);
    expect(skipped).toContain(">It is switched off.<");
    expect(skipped).toContain('<a class="lares-run-status-fix" href="/agents/a/edit">Switch it on</a>');
  });

  it("only requested, waiting and running keep a page polling", () => {
    expect((Object.keys(RUN_STATES) as RunState[]).filter(runStateIsActive)).toEqual(["requested", "waiting", "running"]);
    expect(runStateIsActive(null)).toBe(false);
  });

  it("uses the console's own words where the two vocabularies share a state", () => {
    for (const state of ["running", "waiting", "failed"] as const) {
      expect(RUN_STATES[state].label.toLowerCase()).toBe(STATE_COLOURS[state]!.label);
    }
  });

  it("puts no jargon on screen", () => {
    const words = Object.values(RUN_STATES).map((s) => `${s.label} ${s.sentence}`).join(" ");
    expect(words).not.toMatch(/claim|heartbeat|tick|job|queue|cron/i);
  });
});

describe("useKeepFresh", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("refreshes every 5 seconds while active, and stops once an answer says it is not", async () => {
    const answers = [true, true, false];
    const spy = vi.fn();
    function Counting() {
      const [active, setActive] = useState(true);
      useKeepFresh(active, () => { spy(); setActive(answers.shift() ?? false); });
      return null;
    }
    render(<Counting />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_900); });
    expect(spy).toHaveBeenCalledTimes(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(spy).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("never refreshes when nothing is on its way", async () => {
    const spy = vi.fn();
    function Idle() { useKeepFresh(false, spy); return null; }
    render(<Idle />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps going after a refresh that throws", async () => {
    let calls = 0;
    function Throwing() { useKeepFresh(true, () => { calls += 1; throw new Error("offline"); }); return null; }
    render(<Throwing />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
    expect(calls).toBe(3);
  });

  it("stops when the page goes away", async () => {
    const spy = vi.fn();
    function Leaving() { useKeepFresh(true, spy); return null; }
    const { unmount } = render(<Leaving />);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(spy).not.toHaveBeenCalled();
  });
});
