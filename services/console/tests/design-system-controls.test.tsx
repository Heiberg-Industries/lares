// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Choice, Field, FieldGroup, Page } from "@lares/ui/patterns";
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
