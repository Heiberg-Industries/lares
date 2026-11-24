// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OutsideToolsOverview } from "../components/OutsideToolsOverview";

afterEach(cleanup);
const declared = [{ agent: "alpha", displayName: "Alpha", servers: [{ name: "rates", needsKey: true, tools: ["find_rate", "book_rate"] }, { name: "empty", needsKey: false, tools: [] }] }];

describe("OutsideToolsOverview", () => {
  it("lists each server's tools as rows, not one comma-joined line", () => {
    render(<OutsideToolsOverview declared={declared as never} evidence={{}} />);
    const list = screen.getByRole("list", { name: "Tools on rates" });
    expect([...list.querySelectorAll(".lares-tool-name")].map((n) => n.textContent)).toEqual(["find_rate", "book_rate"]);
    expect(document.body.textContent).not.toContain("find_rate, book_rate");
    expect(screen.queryByRole("list", { name: "Tools on empty" })).toBeNull();
  });

  it("keeps the unreadable and empty messages", () => {
    const { rerender } = render(<OutsideToolsOverview declared={null} evidence={{}} />);
    expect(screen.getByRole("status").textContent).toMatch(/could not be read/);
    rerender(<OutsideToolsOverview declared={[]} evidence={{}} />);
    expect(document.body.textContent).toMatch(/No agent uses outside tools yet/);
  });
});
