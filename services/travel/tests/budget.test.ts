import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Budget } from "../lib/budget.js";

// Ported verbatim from services/marcel/tests/budget.test.ts — same cases, against the
// eve-marcel port of lib/budget.ts (services/travel/lib/budget.ts).

let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "marcel-budget-"));
  file = path.join(root, "budget.json");
});

describe("Budget", () => {
  it("starts at zero and is not exceeded below the limit", () => {
    const b = new Budget(file, 1000, "UTC");
    expect(b.exceeded()).toBe(false);
    b.add(500);
    expect(b.exceeded()).toBe(false);
  });

  it("is exceeded once used reaches the daily limit", () => {
    const b = new Budget(file, 1000, "UTC");
    b.add(1000);
    expect(b.exceeded()).toBe(true);
  });

  it("persists used tokens across instances on the same day", () => {
    const first = new Budget(file, 1000, "UTC");
    first.add(300);
    const second = new Budget(file, 1000, "UTC");
    second.add(300);
    expect(second.exceeded()).toBe(false);
    const third = new Budget(file, 1000, "UTC");
    third.add(500);
    expect(third.exceeded()).toBe(true);
  });

  it("resets used and notified when the persisted date is not today", () => {
    fs.writeFileSync(file, JSON.stringify({ date: "2020-01-01", used: 999999, notified: true }));
    const b = new Budget(file, 100, "UTC");
    expect(b.exceeded()).toBe(false);
    b.add(10);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.used).toBe(10);
    expect(saved.date).not.toBe("2020-01-01");
    expect(saved.notified).toBeFalsy();
  });

  it("notifyOnce returns true exactly once per day, then false", () => {
    const b = new Budget(file, 10, "UTC");
    b.add(10);
    expect(b.exceeded()).toBe(true);
    expect(b.notifyOnce()).toBe(true);
    expect(b.notifyOnce()).toBe(false);
    expect(b.notifyOnce()).toBe(false);
  });

  it("notifyOnce reads the persisted notified flag across instances", () => {
    const a = new Budget(file, 10, "UTC");
    a.add(10);
    expect(a.notifyOnce()).toBe(true);
    const b = new Budget(file, 10, "UTC");
    expect(b.notifyOnce()).toBe(false);
  });

  it("creates missing parent directories when persisting", () => {
    const nested = path.join(root, "nested", "dir", "budget.json");
    const b = new Budget(nested, 10, "UTC");
    b.add(1);
    expect(fs.existsSync(nested)).toBe(true);
  });
});
