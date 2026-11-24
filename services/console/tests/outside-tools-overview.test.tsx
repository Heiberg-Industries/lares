// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OutsideToolsOverview } from "../components/OutsideToolsOverview";

afterEach(cleanup);
const declared = [{ agent: "alpha", displayName: "Alpha", servers: [{ name: "rates", needsKey: true, tools: ["find_rate", "book_rate"], free: 1 }, { name: "empty", needsKey: false, tools: [], free: 0 }] }];

describe("OutsideToolsOverview", () => {
  it("lists each server's tools as rows, not one comma-joined line", () => {
    render(<OutsideToolsOverview declared={declared as never} evidence={{}} />);
    const list = screen.getByRole("list", { name: "Tools on rates" });
    expect([...list.querySelectorAll(".lares-tool-name")].map((n) => n.textContent)).toEqual(["find_rate", "book_rate"]);
    expect(document.body.textContent).not.toContain("find_rate, book_rate");
    expect(screen.queryByRole("list", { name: "Tools on empty" })).toBeNull();
  });

  it("says a key held in custody is kept in Lares, and never reports it as a missing file", () => {
    const evidence = { alpha: { keys: { available: true, value: { rates: "custody" } }, locks: { available: true, value: {} } } };
    render(<OutsideToolsOverview declared={declared as never} evidence={evidence as never} />);
    expect(document.body.textContent).toContain("Key kept in Lares.");
    expect(document.body.textContent).not.toContain("Key file missing");
  });

  it("keeps the unreadable and empty messages", () => {
    const { rerender } = render(<OutsideToolsOverview declared={null} evidence={{}} />);
    expect(screen.getByRole("status").textContent).toMatch(/could not be read/);
    rerender(<OutsideToolsOverview declared={[]} evidence={{}} />);
    expect(document.body.textContent).toMatch(/No agent uses outside tools yet/);
  });
});
