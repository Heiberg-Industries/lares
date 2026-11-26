import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/link", () => ({ default: () => null }));
import { MEMBERSHIP, OWNER_MENU } from "../components/Nav";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TITLE = /<PageHeader\s[^>]*?\btitle="([^"]+)"/;

/** The title a menu page shows: the PageHeader title in its page file, or in a component that file imports. */
function pageTitle(href: string): string | null {
  const file = join(root, "app", href === "/" ? "" : href.slice(1), "page.tsx");
  const source = readFileSync(file, "utf8");
  const own = TITLE.exec(source)?.[1];
  if (own) return own;
  for (const [, from] of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const imported = `${resolve(dirname(file), from)}.tsx`;
    if (!existsSync(imported)) continue;
    const title = TITLE.exec(readFileSync(imported, "utf8"))?.[1];
    if (title) return title;
  }
  return null;
}

/** Pages whose title does not say what the menu says yet, with the title they show today. The slices that
    restyle these pages rename them and delete their line. Nothing may be added here. */
const NOT_YET: Record<string, string> = {
  "/": "Your house",
  "/reviews": "Waiting on you",
  "/writing-style": "Email writing style",
  "/saved-preferences": "Preferences",
  "/permission-checks": "Permission activity",
  "/alerts": "Signals",
  "/general": "Settings",
  "/quiet-hours-and-delivery": "Proactivity",
  "/alert-routing": "Signal routes",
  "/backups": "Backup",
};

const pages = [...OWNER_MENU.flatMap((group) => group.pages), MEMBERSHIP];

describe("each menu page is titled with its menu words", () => {
  it("finds a title on every menu page", () => {
    expect(pages.filter((page) => pageTitle(page.href) === null).map((page) => page.href)).toEqual([]);
  });

  it("the title equals the menu words, except on the listed pages", () => {
    const wrong = pages
      .filter((page) => !(page.href in NOT_YET) && pageTitle(page.href) !== page.label)
      .map((page) => `${page.href}: menu says "${page.label}", page says "${pageTitle(page.href)}"`);
    expect(wrong, "Give the page the title its menu entry has.").toEqual([]);
  });

  it("the list of exceptions is true and does not go stale", () => {
    const hrefs = new Set(pages.map((page) => page.href));
    expect(Object.keys(NOT_YET).filter((href) => !hrefs.has(href)), "Listed, but not a menu page.").toEqual([]);
    const fixed = pages.filter((page) => page.href in NOT_YET && pageTitle(page.href) === page.label).map((page) => page.href);
    expect(fixed, "This page's title matches its menu words now. Delete its line from NOT_YET.").toEqual([]);
    const moved = Object.entries(NOT_YET).filter(([href, title]) => hrefs.has(href) && pageTitle(href) !== title).map(([href]) => href);
    expect(moved, "This page's title changed. Make it the menu words and delete its line, or correct the line.").toEqual([]);
  });
});
