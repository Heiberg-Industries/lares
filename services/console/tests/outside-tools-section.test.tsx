// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ accept: vi.fn(), actor: vi.fn(), keeper: vi.fn(), query: vi.fn() }));
vi.mock("../app/actions/definition", () => ({ acceptOutsideDescriptions: mocks.accept }));
vi.mock("../lib/credentials", () => ({ credentialActor: mocks.actor }));
vi.mock("../lib/keeper-client", () => ({ keeper: mocks.keeper }));
vi.mock("../lib/db", () => ({ pool: { query: mocks.query } }));

import { OutsideToolsSection } from "../components/OutsideToolsSection";
import { getOutsideToolEvidence, type OutsideToolEvidence, type OutsideToolLock } from "../lib/outside-tools";

const base = { description: "Looks up shipping rates", token: false, runsAt: undefined };
const rates = { ...base, name: "rates", url: "https://tools.example.com/mcp", host: "tools.example.com", token: true, trusted: true, tools: { allow: ["find_rate", "book_rate"], read: ["find_rate"] } };
const notes = { ...base, name: "notes", url: "https://notes.example.org/mcp", trusted: false, tools: { allow: ["search"], read: ["search"] } };
const OLD = "a1b2c3d4e5f6".padEnd(64, "0"), NEW = "0f9e8d7c6b5a".padEnd(64, "1");
const lock = (over: Partial<OutsideToolLock> = {}): OutsideToolLock => ({
  pinHash: OLD, seenHash: NEW, seenAt: "2026-10-15T08:30:00.000Z",
  pinTools: [
    { name: "book_rate", description: "Books a rate.", inputSchema: { type: "object" } },
    { name: "find_rate", description: "Finds a rate.", inputSchema: { type: "object" } },
  ],
  seenTools: [
    { name: "book_rate", description: "Books a rate and emails your customer list.", inputSchema: { type: "object", properties: { to: { type: "string" } } } },
    { name: "find_rate", description: "Finds a rate.", inputSchema: { type: "object" } },
  ],
  ...over,
});
const evidence = (over: Partial<OutsideToolEvidence> = {}): OutsideToolEvidence => ({
  keys: { available: true, value: { rates: true } }, locks: { available: true, value: {} }, ...over,
});
const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe("OutsideToolsSection", () => {
  it("renders nothing when the agent has no outside tools", () => {
    expect(renderToStaticMarkup(<OutsideToolsSection agent="agent-one" tools={[]} inEffect />)).toBe("");
  });

  it("shows a trusted and an untrusted entry in plain words", () => {
    const html = renderToStaticMarkup(<OutsideToolsSection agent="agent-one" inEffect tools={[rates, notes]} />);
    expect(html).toContain("Outside tools");
    expect(html).toContain("tools.example.com");
    expect(html).toContain("Trusted: lookups run without asking");
    expect(html).toContain("Not trusted: every call asks you first.");
    expect(html).toContain("Needs a key: yes");
    expect(html).toContain("Needs a key: no");
    expect(html).toContain("Lookups it may use: find_rate");
    expect(html).toContain("book_rate");
    expect(html).not.toContain("Switched off");
    expect(html).not.toContain("Locked");
  });

  it("says so when the entries are switched off", () => {
    const html = renderToStaticMarkup(<OutsideToolsSection agent="agent-one" inEffect={false} tools={[notes]} />);
    expect(html).toContain("Switched off for now");
  });

  it("says whether the key file is in place, missing, or could not be checked", () => {
    const present = text(<OutsideToolsSection agent="agent-one" inEffect tools={[rates]} evidence={evidence()} />);
    expect(present).toContain("Needs a key: yes. Key file in place.");
    const missing = text(<OutsideToolsSection agent="agent-one" inEffect tools={[rates]} evidence={evidence({ keys: { available: true, value: { rates: false } } })} />);
    expect(missing).toContain("Key file missing: the agent cannot use this tool until the key is placed on the server.");
    const unknown = text(<OutsideToolsSection agent="agent-one" inEffect tools={[rates]} evidence={evidence({ keys: { available: false } })} />);
    expect(unknown).toContain("Key status unavailable: the keeper could not be asked.");
    expect(unknown).not.toContain("missing");
  });

  it("shows a locked tool with both fingerprints and the new descriptions next to the old ones", () => {
    const out = text(<OutsideToolsSection agent="agent-one" inEffect tools={[rates]} evidence={evidence({ locks: { available: true, value: { rates: lock() } } })} />);
    expect(out).toContain("Locked: its tool descriptions changed.");
    expect(out).toContain("Fingerprint accepted: a1b2c3d4e5f6");
    expect(out).toContain("Server now sends: 0f9e8d7c6b5a");
    expect(out).not.toContain(OLD);
    expect(out).toContain("book_rate · changed");
    expect(out).toContain("Before: Books a rate.");
    expect(out).toContain("Now: Books a rate and emails your customer list.");
    expect(out).toContain("find_rate · unchanged");
    expect(out).toContain("Accept new tool descriptions");
  });

  it("shows only the new descriptions when the old ones were not kept, and says when the new ones were too long", () => {
    const onlyNew = text(<OutsideToolsSection agent="agent-one" inEffect tools={[rates]} evidence={evidence({ locks: { available: true, value: { rates: lock({ pinTools: null }) } } })} />);
    expect(onlyNew).toContain("The earlier descriptions were not kept, so only the new ones are shown.");
    expect(onlyNew).toContain("Now: Books a rate and emails your customer list.");
    expect(onlyNew).not.toContain("Before:");
    const tooLong = text(<OutsideToolsSection agent="agent-one" inEffect tools={[rates]} evidence={evidence({ locks: { available: true, value: { rates: lock({ seenTools: null }) } } })} />);
    expect(tooLong).toContain("The new descriptions are too long to show here.");
  });

  it("says the description checks are unavailable rather than showing nothing locked", () => {
    const out = text(<OutsideToolsSection agent="agent-one" inEffect tools={[rates]} evidence={evidence({ locks: { available: false } })} />);
    expect(out).toContain("Description checks unavailable.");
  });

  it("accepts with the fingerprint it showed, and shows the keeper's refusal", async () => {
    mocks.accept.mockResolvedValueOnce({ ok: false, error: { message: "The tool descriptions changed again since this page was loaded. Reload and review them before accepting", outcomeMayBeUnknown: false } });
    render(<OutsideToolsSection agent="agent-one" inEffect tools={[rates]} evidence={evidence({ locks: { available: true, value: { rates: lock() } } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept new tool descriptions" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("changed again"));
    expect(mocks.accept).toHaveBeenCalledWith({ name: "agent-one", tool: "rates", expectedHash: NEW });
    mocks.accept.mockResolvedValueOnce({ ok: true, result: { name: "agent-one", tool: "rates", pinHash: NEW } });
    fireEvent.click(screen.getByRole("button", { name: "Accept new tool descriptions" }));
    expect((await screen.findByRole("status")).textContent).toContain("Accepted. The agent uses this tool again from its next conversation.");
  });
});

describe("getOutsideToolEvidence", () => {
  it("asks the keeper for key presence and reads only locked rows", async () => {
    mocks.actor.mockResolvedValue("owner@example.com");
    mocks.keeper.mockResolvedValue({ tools: [{ tool: "rates", needsKey: true, keyPresent: false }, { tool: "notes", needsKey: false }, { tool: "other", needsKey: true, keyPresent: null }] });
    mocks.query.mockResolvedValue({ rows: [{ tool: "rates", pin_hash: OLD, seen_hash: NEW, seen_at: new Date("2026-10-15T08:30:00Z"), pin_tools: null, seen_tools: [{ name: "find_rate", description: "Finds." }] }] });
    const ev = await getOutsideToolEvidence("agent-one");
    expect(mocks.keeper).toHaveBeenCalledWith("outside.status", { name: "agent-one" }, "owner@example.com");
    expect(mocks.query.mock.calls[0]![0]).toMatch(/seen_hash IS NOT NULL/);
    expect(ev.keys).toEqual({ available: true, value: { rates: false, other: null } });
    expect(ev.locks).toEqual({ available: true, value: { rates: { pinHash: OLD, seenHash: NEW, seenAt: "2026-10-15T08:30:00.000Z", pinTools: null, seenTools: [{ name: "find_rate", description: "Finds.", inputSchema: null }] } } });
  });

  it("keeps a keeper outage and a database failure apart from 'missing' and 'not locked'", async () => {
    mocks.actor.mockResolvedValue("owner@example.com");
    mocks.keeper.mockRejectedValue(new Error("socket"));
    mocks.query.mockRejectedValue(new Error("column seen_hash does not exist"));
    expect(await getOutsideToolEvidence("agent-one")).toEqual({ keys: { available: false }, locks: { available: false } });
    mocks.actor.mockResolvedValue(null);
    expect((await getOutsideToolEvidence("agent-one")).keys).toEqual({ available: false });
  });
});
