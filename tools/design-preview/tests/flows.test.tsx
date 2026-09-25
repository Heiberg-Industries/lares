import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  render,
  screen,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
afterEach(cleanup);
beforeEach(() => {
  location.hash = "";
  document.documentElement.classList.remove("dark");
});
const nav = async (name: string) =>
  userEvent.click(
    within(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).getByRole("button", { name, exact: true }),
  );
describe("standalone preview journeys", () => {
  it("creates, edits, retires and deletes a sample agent", async () => {
    const user = userEvent.setup();
    render(<App />);
    await nav("Agents");
    await user.click(
      screen.getByRole("button", { name: "Create agent", exact: true }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Agent name"), "Atlas");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Starting permissions")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Create sample agent" }),
    );
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Edit agent", exact: true }),
    );
    const instructions = screen.getByLabelText("Agent instructions");
    await user.clear(instructions);
    await user.type(instructions, "Keep project notes organised.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Keep project notes organised.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Actions for Atlas" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Retire agent", exact: true }),
    );
    await user.click(
      screen.getByRole("button", { name: "Retire sample agent" }),
    );
    expect(
      screen.getByText(
        "This agent is retired. Its history is preserved and its settings are read-only.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Actions for Atlas" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete agent…" }));
    await user.click(
      screen.getByRole("button", { name: "Delete sample agent" }),
    );
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Atlas", exact: true }),
    ).toBeNull();
  });
  it("validates duplicate names and keeps the entered instructions", async () => {
    const user = userEvent.setup();
    render(<App />);
    await nav("Agents");
    await user.click(
      screen.getByRole("button", { name: "Create agent", exact: true }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Agent name"), "Saga");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "already uses that name",
    );
    expect(
      (screen.getByLabelText("Agent instructions") as HTMLTextAreaElement)
        .value,
    ).toContain("inbox");
  });
  it("records a sample approval without claiming that an email was sent", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Review draft" }));
    expect(screen.getByText("Kari Hansen <kari@example.com>")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Approve sample draft" }),
    );
    expect(screen.getByText("Nothing waiting on you.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "No email was sent",
    );
  });
  it("renders AI Elements chat and cancels a pending sample reply on new conversation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await nav("Chat");
    expect(screen.getByRole("log")).toBeTruthy();
    await user.type(
      screen.getByRole("textbox", { name: "Message Saga" }),
      "Hello",
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Saga",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.getByText("Hello")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/No model was called/)).toBeTruthy(),
    );
    await user.click(
      screen.getByRole("button", { name: "What needs my attention?" }),
    );
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.getByText("A little room to talk.")).toBeTruthy();
    expect(screen.queryByText("Preparing sample response…")).toBeNull();
  });
  it("keeps each agent conversation when switching agents", async () => {
    const user = userEvent.setup();
    render(<App />);
    await nav("Chat");
    await user.type(
      screen.getByRole("textbox", { name: "Message Saga" }),
      "Remember this draft",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.click(
      screen.getByRole("button", { name: "Choose agent, current agent Saga" }),
    );
    await user.click(screen.getByRole("menuitem", { name: /Marcel/ }));
    expect(
      screen.getByRole("textbox", { name: "Message Marcel" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: "Choose agent, current agent Marcel",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: /Saga/ }));
    expect(
      screen.getByText("Remember this draft").closest("[hidden]"),
    ).toBeNull();
  });
  it("uploads an agent image, saves it, and restores its default icon", async () => {
    const user = userEvent.setup();
    render(<App />);
    await nav("Agents");
    await user.click(
      screen.getByRole("button", { name: "Create agent", exact: true }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Agent name"), "Atlas");
    await user.upload(
      screen.getByLabelText("Agent image"),
      new File([new Uint8Array([137, 80, 78, 71])], "avatar.png", {
        type: "image/png",
      }),
    );
    await waitFor(() =>
      expect(
        document.querySelector(".avatar-editor img")?.getAttribute("src"),
      ).toMatch(/^data:image\/png/),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      screen.getByRole("button", { name: "Create sample agent" }),
    );
    expect(document.querySelector(".agent-meta img")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Edit agent", exact: true }),
    );
    await user.click(screen.getByRole("button", { name: "Use default icon" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(document.querySelector(".agent-meta img")).toBeNull();
  });
  it("switches theme and previews the marketing form without submitting data", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Use dark theme" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Marketing", exact: true }),
    );
    expect(
      screen.getByRole("heading", { name: /Agents that live/ }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Pause background animation" }),
    );
    expect(
      document
        .querySelector(".hero-field")
        ?.classList.contains("motion-paused"),
    ).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Play background animation" }),
    );
    expect(
      document
        .querySelector(".hero-field")
        ?.classList.contains("motion-paused"),
    ).toBe(false);
    await user.type(
      screen.getByRole("textbox", { name: "Email" }),
      "owner@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Preview signup" }));
    expect(
      screen.getByText("No details were sent. This is a local preview."),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Explore the console" }),
    );
    expect(
      screen.getByRole("heading", { name: "The house is in order." }),
    ).toBeTruthy();
  });
});
