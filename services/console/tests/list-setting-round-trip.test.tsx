// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setAgentSetting } from "../app/actions/definition";
import { AgentSettingsSections } from "../components/AgentSettingsControl";
import { hourBoxes, parseHours } from "../components/ScheduleHoursControl";
import type { AgentSettingView } from "../lib/agent-settings";
import { draftOf, draftText, LIST_SETTINGS, tracksFrom, tracksText, valuesFrom, valuesText } from "../lib/list-setting";
vi.mock("../app/actions/definition", () => ({ setAgentSetting: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// The list boxes change how a list is typed, never what is saved. Every case below compares the text a save
// sends with the text the one text field would have sent.

const BRANDS = '["EXAMPLE_BRAND","SECOND_BRAND"]';
const DOMAINS = '["authority.example","register.example"]';
const TRACKS = '[{"id":"TRACK_A","description":"New customers","closingSteps":["WON","LOST"]},{"id":"TRACK_B","description":""}]';

const setting = (over: Partial<AgentSettingView>): AgentSettingView => ({
  key: "COMMERCIAL_BRANDS", section: "Business data", label: "Commercial brands", description: "The brands.",
  value: BRANDS, from: "console", agentCount: 1, ...over,
});
const saved = (key: string, value: string | null) =>
  ({ ok: true, result: { key, value, restarted: [], waiting: [], stopped: [] } }) as any;
const sent = () => vi.mocked(setAgentSetting).mock.calls.at(-1)?.[0];

describe("a saved list goes through the boxes unchanged", () => {
  it("as text: loading a saved value and writing it back gives the identical text", () => {
    for (const [key, stored] of [["COMMERCIAL_BRANDS", BRANDS], ["INSTITUTIONAL_SENDER_DOMAINS", DOMAINS], ["CRM_BRANDS", TRACKS]] as const) {
      const draft = draftOf(key, stored);
      expect(draft.kind, key).toBe(LIST_SETTINGS[key]);
      expect(draftText(draft, stored), key).toBe(stored);
    }
    // Rewriting from the boxes gives the same text too, so a list that was edited and put back is identical.
    expect(valuesText(valuesFrom(BRANDS)!)).toBe(BRANDS);
    expect(valuesText(valuesFrom(DOMAINS)!)).toBe(DOMAINS);
    expect(tracksText(tracksFrom(TRACKS)!)).toBe(TRACKS);
  });

  it("an unchanged value from the installation file is sent back character for character, spacing included", () => {
    const fromFile = ' [ "EXAMPLE_BRAND" ,\t"SECOND_BRAND" ] ';
    expect(draftText(draftOf("COMMERCIAL_BRANDS", fromFile), fromFile)).toBe(fromFile);
    expect(draftText(draftOf("INSTITUTIONAL_SENDER_DOMAINS", "[]"), "[]")).toBe("[]");
  });

  it("on the page: load a saved list, change nothing, save: the same text is sent", async () => {
    vi.mocked(setAgentSetting).mockResolvedValue(saved("COMMERCIAL_BRANDS", BRANDS));
    render(<AgentSettingsSections canChange settings={[setting({})]} />);
    expect(screen.getByLabelText("Commercial brands 1")).toHaveProperty("value", "EXAMPLE_BRAND");
    expect(screen.getByLabelText("Commercial brands 2")).toHaveProperty("value", "SECOND_BRAND");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent()).toEqual({ key: "COMMERCIAL_BRANDS", value: BRANDS }));
  });

  it("on the page: add one value and remove one: the expected list is sent, in the stored form", async () => {
    vi.mocked(setAgentSetting).mockResolvedValue(saved("COMMERCIAL_BRANDS", '["SECOND_BRAND","THIRD_BRAND"]'));
    render(<AgentSettingsSections canChange settings={[setting({})]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.type(screen.getByLabelText("Commercial brands 3"), "THIRD_BRAND");
    await userEvent.click(screen.getByRole("button", { name: "Remove EXAMPLE_BRAND" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent()).toEqual({ key: "COMMERCIAL_BRANDS", value: '["SECOND_BRAND","THIRD_BRAND"]' }));
    // The boxes then show what was saved.
    await waitFor(() => expect(document.body.textContent).toContain("Saved."));
    expect(screen.getByLabelText("Commercial brands 1")).toHaveProperty("value", "SECOND_BRAND");
    expect(screen.getByLabelText("Commercial brands 2")).toHaveProperty("value", "THIRD_BRAND");
  });

  it("on the page: adding a value and taking it away again sends the loaded text", async () => {
    vi.mocked(setAgentSetting).mockResolvedValue(saved("INSTITUTIONAL_SENDER_DOMAINS", DOMAINS));
    render(<AgentSettingsSections canChange settings={[setting({ key: "INSTITUTIONAL_SENDER_DOMAINS", label: "Authority sender domains", value: DOMAINS })]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.type(screen.getByLabelText("Authority sender domains 3"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Remove x" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent()).toEqual({ key: "INSTITUTIONAL_SENDER_DOMAINS", value: DOMAINS }));
  });

  it("an empty box is not a value, and removing every value clears the setting as an empty field did", async () => {
    expect(valuesText(["A", " ", ""])).toBe('["A"]');
    vi.mocked(setAgentSetting).mockResolvedValue(saved("COMMERCIAL_BRANDS", null));
    render(<AgentSettingsSections canChange settings={[setting({ value: '["ONLY"]' })]} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove ONLY" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent()).toEqual({ key: "COMMERCIAL_BRANDS", value: "" }));
    await waitFor(() => expect(document.body.textContent).toContain("cleared"));
  });

  it("a setting that is not set yet starts with no boxes and saves the first value in the stored form", async () => {
    vi.mocked(setAgentSetting).mockResolvedValue(saved("COMMERCIAL_BRANDS", '["FIRST"]'));
    render(<AgentSettingsSections canChange settings={[setting({ value: null, from: "none" })]} />);
    expect(screen.queryByLabelText("Commercial brands 1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.type(screen.getByLabelText("Commercial brands 1"), "FIRST");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent()).toEqual({ key: "COMMERCIAL_BRANDS", value: '["FIRST"]' }));
  });
});

describe("tracks", () => {
  const tracks = setting({ key: "CRM_BRANDS", label: "CRM tracks", value: TRACKS });

  it("load saved tracks, change nothing, save: the same text is sent", async () => {
    vi.mocked(setAgentSetting).mockResolvedValue(saved("CRM_BRANDS", TRACKS));
    render(<AgentSettingsSections canChange settings={[tracks]} />);
    const first = within(screen.getByRole("group", { name: "Track 1" }));
    expect(first.getByLabelText(/Track value/)).toHaveProperty("value", "TRACK_A");
    expect(first.getByLabelText(/What it is for/)).toHaveProperty("value", "New customers");
    expect(first.getByLabelText("Closing stage of track 1 2")).toHaveProperty("value", "LOST");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent()).toEqual({ key: "CRM_BRANDS", value: TRACKS }));
  });

  it("add a closing stage and remove a track: the expected text is sent, and a track that named no stages still names none", async () => {
    vi.mocked(setAgentSetting).mockResolvedValue(saved("CRM_BRANDS", TRACKS));
    render(<AgentSettingsSections canChange settings={[tracks]} />);
    const second = within(screen.getByRole("group", { name: "Track 2" }));
    await userEvent.type(second.getByLabelText(/What it is for/), "Renewals");
    await userEvent.click(screen.getByRole("button", { name: "Remove WON" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent()).toEqual({
      key: "CRM_BRANDS",
      value: '[{"id":"TRACK_A","description":"New customers","closingSteps":["LOST"]},{"id":"TRACK_B","description":"Renewals"}]',
    }));
    cleanup();
    render(<AgentSettingsSections canChange settings={[tracks]} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove track 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent()).toEqual({ key: "CRM_BRANDS", value: '[{"id":"TRACK_B","description":""}]' }));
  });
});

describe("a value the boxes cannot show in full", () => {
  it("stays in the one text field, so nothing in it is dropped", async () => {
    for (const [key, stored] of [
      ["COMMERCIAL_BRANDS", "not a list"],
      ["COMMERCIAL_BRANDS", '["A",3]'],
      ["CRM_BRANDS", '[{"id":"TRACK_A","note":"something else"}]'],
      ["CRM_BRANDS", '[{"description":"no id"}]'],
    ] as const) {
      expect(draftOf(key, stored), stored).toEqual({ kind: "text", text: stored });
      expect(draftText(draftOf(key, stored), stored)).toBe(stored);
    }
    vi.mocked(setAgentSetting).mockResolvedValue(saved("COMMERCIAL_BRANDS", "not a list"));
    render(<AgentSettingsSections canChange settings={[setting({ value: "not a list", from: "installation file" })]} />);
    expect(screen.getByLabelText(/Commercial brands \(empty to clear\)/)).toHaveProperty("value", "not a list");
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("a setting that is not a list keeps its one text field", () => {
    expect(draftOf("TELEGRAM_BOT_USERNAME", '["looks","like","a","list"]')).toEqual({ kind: "text", text: '["looks","like","a","list"]' });
  });
});

describe("schedule hours", () => {
  it("one box per hour is read exactly as the comma-separated text was", () => {
    const asText = (text: string) => text.split(/[,\s]+/u).map((s) => s.trim()).filter((s) => s.length > 0).map((s) => Number(s));
    for (const hours of [[8], [9, 17], [9, 13, 17], [0, 4, 8, 12, 16, 20]]) {
      expect(parseHours(hourBoxes(hours))).toEqual(hours);
      expect(parseHours(hourBoxes(hours))).toEqual(asText(hours.join(", ")));
    }
    // Add one, remove one.
    expect(parseHours([...hourBoxes([9, 13, 17]).filter((hour) => hour !== "13"), "20"])).toEqual([9, 17, 20]);
    // An empty box is dropped; something that is not a number still reaches the server's own check.
    expect(parseHours(["9", "", " "])).toEqual([9]);
    expect(parseHours(["nine"])).toEqual([NaN]);
  });
});
