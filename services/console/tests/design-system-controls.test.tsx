// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { Choice, Field, FieldGroup, Notice, Page, ToolList, ToolRow } from "@lares/ui/patterns";
import { Switch } from "@lares/ui/primitives/switch";
import { Checkbox, Radio } from "@lares/ui/primitives/checkbox";
import { Select } from "@lares/ui/primitives/select";
import { Textarea } from "@lares/ui/primitives/textarea";

afterEach(cleanup);

describe("design-system form controls", () => {
  it("post the same form fields as the browser's own controls", () => {
    render(
      <form aria-label="sample">
        <Field label="Who"><Select name="who" defaultValue="b"><option value="a">A</option><option value="b">B</option></Select></Field>
        <Field label="Note" hint="Optional"><Textarea name="note" defaultValue="hello" /></Field>
        <FieldGroup legend="Members">
          <Choice><Checkbox name="members" value="one" defaultChecked />One</Choice>
          <Choice><Checkbox name="members" value="two" />Two</Choice>
        </FieldGroup>
        <Choice><Radio name="mode" value="x" defaultChecked />X</Choice>
      </form>,
    );
    const data = new FormData(screen.getByRole("form", { name: "sample" }) as HTMLFormElement);
    expect(Object.fromEntries(data)).toEqual({ who: "b", note: "hello", members: "one", mode: "x" });
    expect(data.getAll("members")).toEqual(["one"]);
  });

  it("name each control by its visible words", () => {
    render(
      <>
        <Field label="Who"><Select><option>A</option></Select></Field>
        <Choice><Checkbox />One</Choice>
        <FieldGroup legend="Members"><Choice><Radio />X</Choice></FieldGroup>
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Who" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "One" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Members" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "X" })).toBeTruthy();
  });
});

describe("Page", () => {
  it("is wide unless a form, settings or chat page asks for narrow", () => {
    const { container, rerender } = render(<Page>content</Page>);
    expect(container.querySelector(".lares-page")?.getAttribute("data-width")).toBe("wide");
    rerender(<Page width="narrow" className="lares-stack">content</Page>);
    const page = container.querySelector(".lares-page");
    expect(page?.getAttribute("data-width")).toBe("narrow");
    expect(page?.classList.contains("lares-stack")).toBe(true);
  });
});

describe("Notice tones", () => {
  it("gives each tone its own marker and icon, and announces only errors as alerts", () => {
    const tones = ["info", "working", "success", "needs-you", "error"] as const;
    const { container } = render(<>{tones.map((tone) => <Notice key={tone} tone={tone}>{tone} words</Notice>)}</>);
    const found = [...container.querySelectorAll(".lares-notice")];
    expect(found.map((n) => n.getAttribute("data-tone"))).toEqual([...tones]);
    expect(found.every((n) => n.querySelector(".lares-notice-icon svg"))).toBe(true);
    expect(found.map((n) => n.getAttribute("role"))).toEqual(["status", "status", "status", "status", "alert"]);
    expect(found.map((n) => n.querySelector(".lares-notice-icon")?.innerHTML).filter((v, i, all) => all.indexOf(v) === i)).toHaveLength(5);
  });

  it("keeps error as shorthand for the error tone, and info as the default", () => {
    render(<><Notice error>bad</Notice><Notice>fine</Notice></>);
    expect(screen.getByRole("alert").getAttribute("data-tone")).toBe("error");
    expect(screen.getByRole("status").getAttribute("data-tone")).toBe("info");
  });
});

describe("Switch and ToolList", () => {
  it("is named by its label and flips on click", () => {
    let seen: boolean | undefined;
    render(<Switch aria-label="find_rate" onCheckedChange={(on) => { seen = on; }} />);
    const sw = screen.getByRole("switch", { name: "find_rate" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(seen).toBe(true);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("shows name, kind badge, a short description in full and a long one folded away", () => {
    const long = "Finds a rate. ".repeat(20);
    render(
      <ToolList label="Tools">
        <ToolRow name="find_rate" kind="read" description="Looks up a rate" control={<Switch aria-label="find_rate" />} />
        <ToolRow name="book_rate" kind="change" description={long} />
      </ToolList>,
    );
    expect(screen.getByRole("list", { name: "Tools" }).querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("Looks things up")).toBeTruthy();
    expect(screen.getByText("Changes something")).toBeTruthy();
    expect(screen.getByText("Looks up a rate").closest("details")).toBeNull();
    const folded = document.querySelector("details.lares-tool-description") as HTMLDetailsElement;
    expect(folded.open).toBe(false);
    expect(folded.querySelector("p")?.textContent).toBe(long);
  });
});
