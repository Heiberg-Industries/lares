// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));
vi.mock("../app/actions/avatar", () => ({ saveAvatar: mocks.save }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { AvatarEditor } from "../components/AvatarEditor";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("shows the saved image, then the default symbol after a successful reset", async () => {
  mocks.save.mockResolvedValueOnce({ ok: true, message: "Default image restored." });
  render(<AvatarEditor name="console-proof" role="chief-of-staff" initialVersion="123" />);

  expect(screen.getByText("Current image")).toBeTruthy();
  expect(document.querySelector(".lares-avatar-preview img")?.getAttribute("src"))
    .toBe("/api/agents/console-proof/avatar?v=123");

  await userEvent.click(screen.getByRole("button", { name: "Restore default" }));
  await waitFor(() => expect(screen.getByText("Default symbol")).toBeTruthy());
  expect(document.querySelector(".lares-avatar-preview img")).toBeNull();
  expect(screen.getByText("Default image restored.")).toBeTruthy();
});

it("updates the preview only after the save succeeds", async () => {
  mocks.save.mockResolvedValueOnce({ ok: true, message: "Image saved." });
  render(<AvatarEditor name="console-proof" role="chief-of-staff" />);
  const file = new File(["png"], "test.png", { type: "image/png" });
  await userEvent.upload(screen.getByLabelText("Choose an image"), file);
  fireEvent.submit(screen.getByRole("button", { name: "Save image" }).closest("form")!);

  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByText("Current image")).toBeTruthy());
  expect(document.querySelector(".lares-avatar-preview img")?.getAttribute("src"))
    .toMatch(/^\/api\/agents\/console-proof\/avatar\?v=\d+$/);
  expect(screen.getByText("Image saved.")).toBeTruthy();
});
