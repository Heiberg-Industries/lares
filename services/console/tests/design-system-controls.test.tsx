// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Choice, Col, Field, FieldGroup, Notice, Page, Row, Rows, StatusBadge, ToolList, ToolRow } from "@lares/ui/patterns";
import { Alert, AlertDescription, AlertTitle } from "@lares/ui/primitives/alert";
import { Badge } from "@lares/ui/primitives/badge";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@lares/ui/primitives/sheet";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@lares/ui/primitives/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@lares/ui/primitives/tooltip";
import { Switch } from "@lares/ui/primitives/switch";
import { Checkbox, Radio } from "@lares/ui/primitives/checkbox";
import { Select } from "@lares/ui/primitives/select";
import { Textarea } from "@lares/ui/primitives/textarea";

afterEach(cleanup);
// jsdom has no ResizeObserver; the floating parts (tooltip) ask for one to measure their anchor.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

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

  it("places a block on the grid by a named span, and by nothing else", () => {
    const { container } = render(<Page><Col span={8}>main</Col><Col span={4} className="lares-stack">side</Col><section>whole row</section></Page>);
    const page = container.querySelector(".lares-page")!;
    expect([...page.children].map((child) => child.className)).toEqual(["lares-col-8", "lares-col-4 lares-stack", ""]);
    // @ts-expect-error five is not a span the grid has
    render(<Col span={5}>no</Col>);
  });
});

// The stylesheets are the other half of the contract: jsdom draws nothing, so read what they say.
const uiSource = dirname(createRequire(import.meta.url).resolve("@lares/ui/console.css"));
const consoleCss = readFileSync(join(uiSource, "console.css"), "utf8");
const themeCss = readFileSync(join(uiSource, "console-theme.css"), "utf8");
const sharedThemeCss = readFileSync(join(uiSource, "theme.css"), "utf8");
/** The declarations of the first rule whose selector list is exactly `selector`. */
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(at, css.indexOf("}", at));
};

describe("the console's values", () => {
  it("are scoped to the console and leave the shared theme alone", () => {
    const selectors = [...themeCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim());
    expect(selectors.length).toBeGreaterThan(1);
    expect(selectors.filter((selector) => !selector.startsWith('html[data-lares="console"]'))).toEqual([]);
    expect(sharedThemeCss).not.toMatch(/data-lares/);
    expect(sharedThemeCss).toContain("--background: oklch(0.988 0.004 175);");
    expect(sharedThemeCss).toContain("--lares-sidebar-width: 232px;");
  });

  it("name a light and a dark value for every colour, in OKLCH, with no green tint in the greys", () => {
    const [light, dark] = [rule(themeCss, 'html[data-lares="console"]'), rule(themeCss, 'html[data-lares="console"].dark')];
    const colours = (block: string) => [...block.matchAll(/(--lares-[a-z-]+): oklch\(([\d.]+) ([\d.]+) ([\d.]+)\);/g)];
    const names = (block: string) => colours(block).map((m) => m[1]);
    expect(names(light)).toHaveLength(26);
    expect(names(dark)).toEqual(names(light));
    expect(themeCss).not.toMatch(/:\s*#[0-9a-f]{3,8}\s*;|rgba?\(/i);
    for (const block of [light, dark]) for (const [, name, , chroma, hue] of colours(block)) {
      if (!/^--lares-(bg|sidebar-bg|surface|sunken|text|text-muted|text-faint|line|line-input|hover|selected|primary|on-primary)$/.test(name!)) continue;
      const tinted = Number(chroma) > 0.02 || (Number(chroma) > 0.002 && Number(hue) > 90 && Number(hue) < 220);
      expect(tinted, `${name} is a grey and must stay neutral`).toBe(false);
    }
  });

  it("set the approved sizes, and the phone sizes at 760px and below", () => {
    const light = rule(themeCss, 'html[data-lares="console"]');
    for (const line of [
      "--lares-sidebar-width: 248px;", "--lares-page-width: 960px;", "--lares-gutter: 24px;", "--lares-grid-columns: 12;",
      "--lares-control-radius: 6px;", "--lares-card-radius: 10px;", "--lares-dialog-radius: 12px;",
      "--lares-control-height: 32px;", "--lares-control-height-sm: 28px;", "--lares-switch-width: 34px;", "--lares-switch-height: 20px;",
      "--lares-row-height: 56px;", "--lares-menu-item-height: 30px;", "--lares-menu-icon: 15px;", "--lares-notice-icon: 18px;", "--lares-badge-dot: 6px;",
      "--lares-type-body: 400 13px/20px var(--font-sans);", "--lares-type-title: 600 20px/28px var(--font-sans);", "--lares-tracking-title: -0.01em;",
      "--lares-type-section: 600 13px/20px var(--font-sans);", "--lares-type-secondary: 400 12px/16px var(--font-sans);",
      "--lares-type-menu-label: 500 11.5px/16px var(--font-sans);", "--lares-type-badge: 500 12px/20px var(--font-sans);",
      "--lares-focus-ring: 0 0 0 3px var(--lares-accent-soft);",
    ]) expect(light, line).toContain(line);
    const phone = themeCss.slice(themeCss.indexOf("@media (max-width: 760px)"));
    for (const line of ["--lares-gutter: 16px;", "--lares-grid-columns: 4;", "--lares-control-height: 44px;", "--lares-control-text: 16px;"]) expect(phone, line).toContain(line);
  });

  it("are the only place a colour is written: the console stylesheet states none of its own", () => {
    const own = consoleCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\.lares-logo-ms span[^}]*\}/g, "");
    expect(own.match(/#[0-9a-f]{3,8}\b|oklch\(|rgba?\(|hsla?\(/gi) ?? []).toEqual([]);
  });
});

describe("the page grid in the stylesheet", () => {
  it("has twelve columns with the gutter, and a child spans them all unless it has a span", () => {
    expect(rule(consoleCss, ".lares-page,\n.lares-page.lares-stack")).toContain("grid-template-columns: repeat(var(--lares-grid-columns), minmax(0, 1fr));");
    expect(rule(consoleCss, ".lares-page,\n.lares-page.lares-stack")).toContain("column-gap: var(--lares-gutter);");
    expect(rule(consoleCss, ".lares-page > *")).toContain("grid-column: 1 / -1;");
    for (const span of [12, 8, 6, 4, 3]) expect(consoleCss).toContain(`.lares-page > .lares-col-${span} { grid-column: span ${span}; }`);
  });

  it("on a phone every span fills the four columns, except 3, which takes two", () => {
    const phone = consoleCss.slice(consoleCss.indexOf(".lares-page > .lares-col-3 { grid-column: span 3; }"));
    const block = phone.slice(phone.indexOf("@media (max-width: 760px)"), phone.indexOf(".lares-page-header"));
    expect(block.replace(/\s+/g, " ")).toContain(".lares-page > .lares-col-12, .lares-page > .lares-col-8, .lares-page > .lares-col-6, .lares-page > .lares-col-4 { grid-column: span 4; }");
    expect(block).toContain(".lares-page > .lares-col-3 { grid-column: span 2; }");
  });
});

describe("Notice tones", () => {
  it("gives each tone its own round icon, and announces only errors as alerts", () => {
    const tones = ["info", "working", "success", "needs-you", "error"] as const;
    const { container } = render(<>{tones.map((tone) => <Notice key={tone} tone={tone}>{tone} words</Notice>)}</>);
    const found = [...container.querySelectorAll(".lares-notice")];
    expect(found.map((n) => n.getAttribute("data-tone"))).toEqual([...tones]);
    expect(found.map((n) => n.getAttribute("role"))).toEqual(["status", "status", "status", "status", "alert"]);
    const icons = found.map((n) => n.querySelector(".lares-notice-icon")!);
    expect(icons.every((icon) => icon.getAttribute("aria-hidden") === "true" && icon.innerHTML !== "")).toBe(true);
    expect(icons.map((icon) => icon.innerHTML).filter((v, i, all) => all.indexOf(v) === i)).toHaveLength(5);
  });

  it("has exactly one warning look, amber with \"!\", and one error look, red with \"×\"", () => {
    const { container } = render(<><Notice tone="needs-you">decide</Notice><Notice tone="error">failed</Notice><Notice error>failed too</Notice><Notice>fyi</Notice></>);
    const [warning, error, shorthand, info] = [...container.querySelectorAll(".lares-notice")];
    expect(warning!.querySelector(".lares-notice-icon")!.textContent).toBe("!");
    expect(error!.querySelector(".lares-notice-icon")!.textContent).toBe("×");
    expect(shorthand!.outerHTML.replace("failed too", "failed")).toBe(error!.outerHTML);
    expect(info!.querySelector(".lares-notice-icon")!.textContent).toBe("i");
    // Notice is the alert part underneath, so both take their colours from one rule.
    expect([warning, error, info].map((n) => [n!.getAttribute("data-slot"), n!.getAttribute("data-variant")])).toEqual([["alert", "warning"], ["alert", "destructive"], ["alert", "default"]]);
    const amber = rule(consoleCss, '.lares-notice[data-tone="needs-you"],\n[data-slot="alert"][data-variant="warning"]');
    for (const value of ["--notice-color: var(--lares-warning-text);", "--notice-bg: var(--lares-warning-bg);", "--notice-line: var(--lares-warning-line);"]) expect(amber).toContain(value);
    const red = rule(consoleCss, '.lares-notice[data-tone="error"],\n[data-slot="alert"][data-variant="destructive"]');
    for (const value of ["--notice-color: var(--lares-error-text);", "--notice-bg: var(--lares-error-bg);", "--notice-line: var(--lares-error-line);"]) expect(red).toContain(value);
    expect(rule(consoleCss, '.lares-notice,\n[data-slot="alert"]')).toContain("--notice-color: var(--lares-info-text);");
    const box = rule(consoleCss, '.lares-notice,\n[data-slot="alert"]');
    for (const value of ["border: 1px solid var(--notice-line);", "border-radius: var(--lares-card-radius);"]) expect(box).toContain(value);
    const icon = rule(consoleCss, ".lares-notice-icon");
    for (const value of ["width: var(--lares-notice-icon);", "height: var(--lares-notice-icon);", "border-radius: 50%;"]) expect(icon).toContain(value);
  });

  it("keeps error as shorthand for the error tone, and info as the default", () => {
    render(<><Notice error>bad</Notice><Notice>fine</Notice></>);
    expect(screen.getByRole("alert").getAttribute("data-tone")).toBe("error");
    expect(screen.getByRole("status").getAttribute("data-tone")).toBe("info");
  });

  it("gives the older hand-made message classes the same two looks through the stylesheet", () => {
    const css = consoleCss.replace(/\s+/g, " ");
    expect(css).toContain(".lares-form-error, .lares-operational-error, .lares-status-error { color: var(--lares-error-text); }");
    expect(css).toContain(".lares-form-success { color: var(--lares-success-text); }");
    const block = rule(consoleCss, "p.lares-form-error,\np.lares-operational-error,\ndiv.lares-operational-error,\np.lares-status-error:not(.lares-small),\np.lares-form-success");
    for (const value of ["border: 1px solid var(--lares-error-line);", "border-radius: var(--lares-card-radius);", "background: var(--lares-error-bg);"]) expect(block).toContain(value);
    expect(css).toMatch(/p\.lares-form-error::before, p\.lares-operational-error::before, [^{]+\{ content: "×";/);
  });
});

describe("Alert", () => {
  it("is announced as an alert unless told otherwise, and names its variant for the stylesheet", () => {
    render(<><Alert><AlertTitle>Heads up</AlertTitle><AlertDescription>Details</AlertDescription></Alert><Alert variant="warning" role="status">Decide</Alert></>);
    const alert = screen.getByRole("alert");
    expect([alert.getAttribute("data-slot"), alert.getAttribute("data-variant")]).toEqual(["alert", "default"]);
    expect(within(alert).getByText("Heads up").getAttribute("data-slot")).toBe("alert-title");
    expect(within(alert).getByText("Details").getAttribute("data-slot")).toBe("alert-description");
    expect(screen.getByRole("status").getAttribute("data-variant")).toBe("warning");
  });
});

describe("Badge", () => {
  it("is a pill with a dot, one variant per status, neutral by default", () => {
    const variants = ["neutral", "success", "warning", "error", "info", "accent"] as const;
    const { container } = render(<><Badge>Off</Badge>{variants.map((variant) => <Badge key={variant} variant={variant}>{variant}</Badge>)}<Badge dot={false}>3</Badge></>);
    const badges = [...container.querySelectorAll("[data-slot=badge]")];
    expect(badges.map((badge) => badge.getAttribute("data-variant"))).toEqual(["neutral", ...variants, "neutral"]);
    expect(badges.map((badge) => badge.querySelectorAll("[data-slot=badge-dot][aria-hidden=true]").length)).toEqual([1, 1, 1, 1, 1, 1, 1, 0]);
    expect(badges[2]!.textContent).toBe("success");
    for (const [variant, token] of [["warning", "warning"], ["success", "success"], ["error", "error"], ["info", "info"]] as const) {
      const colours = consoleCss.slice(consoleCss.indexOf(`[data-slot="badge"][data-variant="${variant}"] {`));
      expect(colours.slice(0, colours.indexOf("}"))).toContain(`--badge-color: var(--lares-${token}-text);`);
      expect(colours.slice(0, colours.indexOf("}"))).toContain(`--badge-bg: var(--lares-${token}-bg);`);
    }
    const pill = rule(consoleCss, '.lares-kind-badge,\n.lares-status,\n[data-slot="badge"]');
    for (const value of ["font: var(--lares-type-badge);", "border-radius: 999px;", "background: var(--badge-bg);", "color: var(--badge-color);"]) expect(pill).toContain(value);
  });

  it("can hand its look to a link, and StatusBadge takes the same look", () => {
    render(<><Badge asChild variant="info"><a href="/somewhere">More</a></Badge><StatusBadge tone="attention" title="why">Needs you</StatusBadge></>);
    const link = screen.getByRole("link", { name: "More" });
    expect([link.getAttribute("data-slot"), link.getAttribute("data-variant"), link.getAttribute("href")]).toEqual(["badge", "info", "/somewhere"]);
    const status = screen.getByText("Needs you");
    expect([status.className, status.getAttribute("data-tone"), status.getAttribute("title")]).toEqual(["lares-status", "attention", "why"]);
    expect(consoleCss.replace(/\s+/g, " ")).toContain('.lares-kind-badge[data-kind="change"], .lares-status[data-tone="attention"], [data-slot="badge"][data-variant="warning"] {');
  });
});

describe("Card and Rows", () => {
  it("is a flat bordered surface whose parts are named, with plain rows inside", () => {
    const { container } = render(
      <Card>
        <CardHeader><CardTitle>Delivery</CardTitle><CardDescription>Where messages go</CardDescription><CardAction><button type="button">Edit</button></CardAction></CardHeader>
        <Rows label="Doors">
          <Row title="Web chat" description="Always on" control={<Switch aria-label="Web chat" />} />
          <Row title="Email">extra</Row>
        </Rows>
        <CardContent>Body</CardContent>
        <CardFooter>Foot</CardFooter>
      </Card>,
    );
    expect([...container.querySelectorAll("[data-slot]")].map((el) => el.getAttribute("data-slot")).filter((slot) => slot!.startsWith("card")))
      .toEqual(["card", "card-header", "card-title", "card-description", "card-action", "card-content", "card-footer"]);
    const rows = within(screen.getByRole("list", { name: "Doors" })).getAllByRole("listitem");
    expect(rows.map((row) => row.className)).toEqual(["lares-row", "lares-row"]);
    expect(within(rows[0]!).getByText("Always on").className).toBe("lares-row-description");
    expect(within(rows[0]!).getByRole("switch", { name: "Web chat" }).closest(".lares-row-control")).toBeTruthy();
    expect(rows[1]!.querySelector(".lares-row-control")).toBeNull();
    const card = rule(consoleCss, '[data-slot="card"]');
    for (const value of ["border: 1px solid var(--lares-line);", "border-radius: var(--lares-card-radius);", "background: var(--lares-surface);"]) expect(card).toContain(value);
    expect(card).not.toContain("shadow");
    const row = rule(consoleCss, ".lares-row,\n.lares-service-row");
    for (const value of ["min-height: var(--lares-row-height);", "border-top: 1px solid var(--lares-line);"]) expect(row).toContain(value);
  });
});

describe("Tooltip", () => {
  it("names nothing until its trigger is focused, then describes it", async () => {
    const user = userEvent.setup();
    render(<TooltipProvider><Tooltip><TooltipTrigger>Copy</TooltipTrigger><TooltipContent>Copy the address</TooltipContent></Tooltip></TooltipProvider>);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.tab();
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe("Copy the address");
    expect(screen.getByRole("button", { name: "Copy" }).getAttribute("aria-describedby")).toBe(tip.id);
    expect(document.querySelector("[data-slot=tooltip-content]")?.classList.contains("lares-tooltip")).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("Sheet", () => {
  it("opens from its trigger as a named dialog on the asked side, closes on Escape and returns focus", async () => {
    const user = userEvent.setup();
    render(<Sheet><SheetTrigger>Filters</SheetTrigger><SheetContent side="left"><SheetTitle>Filter the list</SheetTitle><SheetDescription>Pick any</SheetDescription><a href="/x">A link</a></SheetContent></Sheet>);
    const trigger = screen.getByRole("button", { name: "Filters" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await user.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "Filter the list" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect([sheet.getAttribute("data-slot"), sheet.getAttribute("data-side"), sheet.classList.contains("lares-sheet")]).toEqual(["sheet-content", "left", true]);
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes from its own close button", async () => {
    const user = userEvent.setup();
    render(<Sheet defaultOpen><SheetContent aria-describedby={undefined}><SheetTitle>Panel</SheetTitle></SheetContent></Sheet>);
    expect(screen.getByRole("dialog", { name: "Panel" }).getAttribute("data-side")).toBe("right");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Sidebar", () => {
  const menu = (
    <>
      <SidebarHeader>Brand</SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Group</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem><SidebarMenuButton asChild isActive><a href="/here">Here</a></SidebarMenuButton></SidebarMenuItem>
            <SidebarMenuItem><SidebarMenuButton asChild><a href="/there">There</a></SidebarMenuButton></SidebarMenuItem>
            <SidebarMenuItem><SidebarMenuButton disabled>Later<SidebarMenuBadge>Coming</SidebarMenuBadge></SidebarMenuButton></SidebarMenuItem>
            <SidebarMenuItem><SidebarMenuButton onClick={() => {}}>Do it</SidebarMenuButton></SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>Foot</SidebarFooter>
    </>
  );

  it("is a column of groups and entries: the current one marked, a disabled one plain text", () => {
    render(<SidebarProvider><Sidebar label="Main menu">{menu}</Sidebar><SidebarInset>Page</SidebarInset></SidebarProvider>);
    const side = document.querySelector("aside[data-slot=sidebar]") as HTMLElement;
    expect([...side.querySelectorAll("[data-slot=sidebar-menu-button]")].map((el) => [el.tagName, el.hasAttribute("data-active"), el.getAttribute("aria-disabled")]))
      .toEqual([["A", true, null], ["A", false, null], ["SPAN", false, "true"], ["BUTTON", false, null]]);
    expect(within(side).queryByRole("link", { name: /Later/ })).toBeNull();
    expect(within(side).queryByRole("button", { name: /Later/ })).toBeNull();
    expect(within(side).getByText("Coming").getAttribute("data-slot")).toBe("sidebar-menu-badge");
    expect(screen.getByRole("main").textContent).toBe("Page");
    const button = rule(consoleCss, ".lares-sidebar-menu-button");
    expect(button).toContain("min-height: var(--lares-menu-item-height);");
    const active = rule(consoleCss, ".lares-sidebar-menu-button[data-active]");
    for (const value of ["background: var(--lares-selected);", "font-weight: 500;"]) expect(active).toContain(value);
    expect(rule(consoleCss, "aside.lares-sidebar")).toContain("width: var(--lares-sidebar-width);");
  });

  it("opens the same contents in a named sheet on a phone, and the caller can follow and set whether it is open", async () => {
    const user = userEvent.setup();
    const seen: boolean[] = [];
    function Shell() {
      const [open, setOpen] = React.useState(false);
      return <SidebarProvider openMobile={open} onOpenMobileChange={(next) => { seen.push(next); setOpen(next); }}><Sidebar label="Main menu">{menu}</Sidebar><SidebarTrigger aria-label="Open menu" /><button type="button" onClick={() => setOpen(false)}>Shut</button></SidebarProvider>;
    }
    render(<Shell />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await user.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "Main menu" });
    expect([sheet.getAttribute("data-side"), sheet.getAttribute("data-mobile")]).toEqual(["left", "true"]);
    expect(within(sheet).getByRole("link", { name: "Here" }).getAttribute("href")).toBe("/here");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(seen).toEqual([true, false]);
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

  it("is the approved size, and the accent when on", () => {
    const sw = rule(consoleCss, ".lares-switch");
    for (const value of ["width: var(--lares-switch-width);", "height: var(--lares-switch-height);"]) expect(sw).toContain(value);
    expect(rule(consoleCss, '.lares-switch[data-state="checked"]')).toContain("background: var(--lares-accent);");
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
