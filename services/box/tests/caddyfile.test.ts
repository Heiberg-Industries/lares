import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "ops", "Caddyfile");

describe("the neutral stack's Caddyfile", () => {
  it("names the owner's domain only through the environment, never a literal", () => {
    const text = readFileSync(FILE, "utf8");
    expect(text).toMatch(/\{\$LARES_DOMAIN\}/);
    for (const banned of ["heiberg", "bendik", ".co", ".ai", "orakel", "zero7"]) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });

  it("proxies only to the console, on the compose network's own service name", () => {
    const text = readFileSync(FILE, "utf8");
    expect(text).toMatch(/reverse_proxy\s+console:3000/);
  });

  it("never names a door path — Slack/Telegram webhooks are added from the console later, not by this file", () => {
    const text = readFileSync(FILE, "utf8");
    expect(text).not.toMatch(/\/doors\//);
  });
});
