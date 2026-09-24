import { describe, it, expect, afterEach } from "vitest";
import { isAllowedAdmin } from "../lib/principals.js";

/**
 * Task 2 — the single fail-closed admin check for Marcel's one door (Telegram). Simpler than
 * eve-saga's multi-channel `lib/principals.ts`: one env var (`MARCEL_ADMIN_TELEGRAM_ID`), one
 * trusted id, no channel map.
 */

const BENDIK = "123456789";
const SOMEONE_ELSE = "999999999";

afterEach(() => {
  delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
});

describe("isAllowedAdmin", () => {
  it("admits the id that matches MARCEL_ADMIN_TELEGRAM_ID", () => {
    process.env["MARCEL_ADMIN_TELEGRAM_ID"] = BENDIK;
    expect(isAllowedAdmin(BENDIK)).toBe(true);
  });

  it("refuses an id that does not match", () => {
    process.env["MARCEL_ADMIN_TELEGRAM_ID"] = BENDIK;
    expect(isAllowedAdmin(SOMEONE_ELSE)).toBe(false);
  });

  it("fails closed when MARCEL_ADMIN_TELEGRAM_ID is unset", () => {
    delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
    expect(isAllowedAdmin(BENDIK)).toBe(false);
  });

  it("fails closed when MARCEL_ADMIN_TELEGRAM_ID is an empty string", () => {
    process.env["MARCEL_ADMIN_TELEGRAM_ID"] = "";
    expect(isAllowedAdmin(BENDIK)).toBe(false);
  });

  it("never admits an empty candidate id, even against a blank-punctuated env value", () => {
    process.env["MARCEL_ADMIN_TELEGRAM_ID"] = "   ";
    expect(isAllowedAdmin("")).toBe(false);
  });

  it("trims whitespace around the configured admin id", () => {
    process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ` ${BENDIK} `;
    expect(isAllowedAdmin(BENDIK)).toBe(true);
  });
});
