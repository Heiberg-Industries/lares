// @vitest-environment jsdom
// A door switch saves a new definition; the edit page then shows the saved one instead of asking for a
// reload, but only while nothing on the page is unsaved, before and after the read.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const door = vi.hoisted(() => ({ props: null as null | { onDefinitionChanged?: (hash: string) => void } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../app/actions/definition", () => ({ createAgent: vi.fn(), saveDefinition: vi.fn(), retireAgent: vi.fn(), deleteAgent: vi.fn(), applyConnections: vi.fn(),
  agentRuntime: vi.fn(), savedDefinition: vi.fn(), listConversations: vi.fn(), startFreshConversation: vi.fn() }));
vi.mock("../app/actions/autonomy", () => ({ setAutonomy: vi.fn() }));
vi.mock("../components/DoorSetup", () => ({ DoorSetup: (p: typeof door.props) => { door.props = p; return null; } }));
import { savedDefinition } from "../app/actions/definition";
import { DefinitionForm } from "../components/DefinitionForm";
import { modelAliases, startingPoints, takesEffect } from "../lib/builder";

afterEach(() => { cleanup(); vi.clearAllMocks(); door.props = null; });

const base = { owner: true, startingPoints: startingPoints(), aliases: modelAliases("example"),
  timing: Object.fromEntries(["name", "duties", "voice", "model", "grants", "skills", "schedules", "doors"].map((f) => [f, takesEffect(f)])),
  capacity: { ceiling: 6, activeCount: 3, approved: true, creationAvailable: true, canChange: true } };
const definition = { ...base.startingPoints[0]!.definition, name: "example", model: "example-brain", description: "Before" };
const initial = { definition, duties: "d", voice: "v", hash: "a".repeat(64), runtime: { pending: false, reason: null, running: true, healthy: true }, status: "valid" };
const saved = (description: string) => ({ ok: true, result: { definition: JSON.stringify({ ...definition, description }), duties: "d", voice: "v" } });
const description = () => screen.getByDisplayValue(/Before|Saved by the door switch|Typed meanwhile/) as HTMLInputElement;

describe("a door switch re-reads the saved definition", () => {
  it("shows the saved definition when nothing on the page is unsaved", async () => {
    vi.mocked(savedDefinition).mockResolvedValue(saved("Saved by the door switch") as never);
    render(<DefinitionForm {...base} initial={initial as never} />);
    await act(async () => { door.props!.onDefinitionChanged!("b".repeat(64)); });
    await waitFor(() => expect(description().value).toBe("Saved by the door switch"));
    expect(document.body.textContent).not.toContain("This agent changed. Reload");
  });

  it("never overwrites an edit made while the read was on its way", async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(savedDefinition).mockReturnValue(new Promise((r) => { answer = r; }) as never);
    render(<DefinitionForm {...base} initial={initial as never} />);
    await act(async () => { door.props!.onDefinitionChanged!("b".repeat(64)); });
    fireEvent.change(description(), { target: { value: "Typed meanwhile" } });
    await act(async () => { answer(saved("Saved by the door switch")); });
    expect(description().value).toBe("Typed meanwhile");
    await waitFor(() => expect(document.body.textContent).toContain("This agent changed. Reload to see its current state before editing it again."));
  });
});
