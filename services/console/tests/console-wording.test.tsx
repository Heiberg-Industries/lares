// @vitest-environment jsdom
import React from "react";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentDefinition } from "@lares/agent-kit/definition";
import {
  DefinitionForm,
  CREATE_DONE,
  CREATE_FAILED,
  CREATE_STEPS,
  CREATE_WORKING,
} from "../components/DefinitionForm";
import { CeilingNotice, LIMIT_WHY } from "../components/CeilingNotice";
import { SCHEDULE_EXPLANATIONS, scheduleExplanation } from "../lib/schedule-labels";
import { startingPoints } from "../lib/builder";

const calls = vi.hoisted(() => ({ create: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: calls.push, refresh: vi.fn() }),
}));
vi.mock("../app/actions/definition", () => ({
  createAgent: calls.create,
  saveDefinition: vi.fn(),
  retireAgent: vi.fn(),
  deleteAgent: vi.fn(),
  applyConnections: vi.fn(),
}));
vi.mock("../components/AvatarEditor", () => ({ AvatarEditor: () => null }));
vi.mock("../components/DoorSetup", () => ({ DoorSetup: () => null }));
vi.mock("../components/ConversationControl", () => ({
  ConversationControl: () => null,
}));
const props = {
  startingPoints: [
    {
      id: "creative" as const,
      label: "Thinking partner",
      description: "A little room to think.",
      capabilities: [],
      schedules: [],
      roleMd: "BUILT-IN ROLE TEXT",
      definition: {
        name: "template",
        role: "creative",
        model: "test-brain",
        grants: [],
        autonomy: {},
        skills: [],
        schedules: { "morning-brief": { on: true } },
        channels: [],
        duties: "duties.md",
      } as unknown as AgentDefinition,
    },
  ],
  aliases: [{ alias: "test-brain", label: "Brain", when: "Everyday work" }],
  timing: {},
  capacity: { ceiling: 1, activeCount: 0, approved: true, creationAvailable: true },
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function toReview() {
  await userEvent.click(screen.getByRole("button", { name: "Continue →" }));
  await userEvent.type(screen.getByLabelText("Name (permanent slug)"), "helper");
  await userEvent.click(screen.getByRole("button", { name: "Continue →" }));
}

it("says why the box has a limit and, for the administrator, where to change it", () => {
  const html = renderToStaticMarkup(
    <CeilingNotice capacity={{ ceiling: 1, activeCount: 1, approved: true, creationAvailable: false }} />,
  );
  expect(html).toContain("holds up to 1 agent");
  expect(html).not.toContain("agents.ceiling");
  expect(html).not.toContain("Change it in Settings");
  expect(LIMIT_WHY).toContain("memory");
  expect(LIMIT_WHY).not.toContain("cannot change it yet");
  const admin = renderToStaticMarkup(
    <CeilingNotice capacity={{ ceiling: 1, activeCount: 1, approved: true, creationAvailable: false, canChange: true }} />,
  );
  expect(admin).toContain("Change it in Settings");
  expect(admin).toContain('href="/settings"');
});

it("explains that instructions and personality are added to a built-in default, and shows it", () => {
  render(<DefinitionForm {...props} />);
  const text = document.body.textContent ?? "";
  expect(text).toContain("What you write here is added after it. It does not replace it");
  expect(text).toContain("Added after the built-in role, not instead of it.");
  expect(text).toContain("Show the built-in default");
  expect(text).toContain("BUILT-IN ROLE TEXT");
  expect(text).toContain(
    "The agent’s default language. It switches to another one only when someone asks it to, and only for that conversation.",
  );
});

it("gives every schedule the agent can run a plain sentence, and every template schedule too", () => {
  const dir = resolve(process.cwd(), "../chief-of-staff/agent/schedules");
  const names = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3));
  expect(names.length).toBeGreaterThan(10);
  for (const n of names) expect(scheduleExplanation(n), n).not.toBe("");
  for (const sp of startingPoints())
    for (const n of sp.schedules) expect(scheduleExplanation(n), n).not.toBe("");
  expect(Object.keys(SCHEDULE_EXPLANATIONS).sort()).toEqual(names.sort());
});

it("shows the sentence next to each schedule in the editor", () => {
  render(<DefinitionForm {...props} />);
  expect(document.body.textContent).toContain(scheduleExplanation("morning-brief"));
});

it("shows progress while an agent is being created, then the way out", async () => {
  let finish!: (v: unknown) => void;
  calls.create.mockReturnValue(new Promise((r) => (finish = r)));
  render(<DefinitionForm {...props} />);
  await toReview();
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
  expect(await screen.findByText(CREATE_WORKING)).toBeTruthy();
  for (const step of CREATE_STEPS) expect(document.body.textContent).toContain(step);
  expect(screen.getByRole("button", { name: "Creating…" })).toBeTruthy();
  finish({ ok: true, result: { name: "helper", hash: "h", backup: { ok: true, status: "saved" } } });
  expect(await screen.findByText(CREATE_DONE)).toBeTruthy();
  await waitFor(() => expect(calls.push).toHaveBeenCalled());
});

it("says in plain words when creating fails", async () => {
  calls.create.mockResolvedValue({ ok: false, error: { message: "name already exists", outcomeMayBeUnknown: false } });
  render(<DefinitionForm {...props} />);
  await toReview();
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
  expect(await screen.findByText(CREATE_FAILED)).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toContain("name already exists");
});
