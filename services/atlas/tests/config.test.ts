import { describe, it, expect } from "vitest";
import { readConfig, readSpineToken } from "../lib/config.js";

/** Every secret path maps to a non-empty file unless a test overrides it. */
const files: Record<string, string> = {
  "/run/secrets/gh": "ghp_live\n",
  "/run/secrets/notion": "ntn_live\n",
  "/run/secrets/gw": "sk-gw\n",
};
const read = (p: string): string => {
  const v = files[p];
  if (v === undefined) throw new Error(`ENOENT: ${p}`);
  return v;
};

const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  GITHUB_TOKEN_FILE: "/run/secrets/gh",
  NOTION_TOKEN_FILE: "/run/secrets/notion",
  GATEWAY_KEY_FILE: "/run/secrets/gw",
  ATLAS_DRAFT_MODEL: "some-utility-model",
  ...over,
});

describe("readConfig", () => {
  it("reads secrets from their files and trims them", () => {
    const c = readConfig(env(), read);
    expect(c.githubToken).toBe("ghp_live");
    expect(c.notionToken).toBe("ntn_live");
    expect(c.gatewayKey).toBe("sk-gw");
  });

  it("defaults the two store paths to the box's mounts", () => {
    const c = readConfig(env(), read);
    expect(c.atlasPath).toBe("/srv/atlas");
    expect(c.vaultPath).toBe("/srv/brain");
  });

  it("names the variable that is missing, rather than failing later and vaguely", () => {
    for (const key of ["GITHUB_TOKEN_FILE", "NOTION_TOKEN_FILE", "GATEWAY_KEY_FILE", "ATLAS_DRAFT_MODEL"]) {
      const broken = env();
      delete broken[key];
      expect(() => readConfig(broken, read)).toThrow(new RegExp(key));
    }
  });

  it("treats a whitespace-only env var as missing", () => {
    expect(() => readConfig(env({ ATLAS_DRAFT_MODEL: "   " }), read)).toThrow(/ATLAS_DRAFT_MODEL/);
  });

  it("REFUSES an empty secret file — a mounted-but-blank secret is not a token", () => {
    // The failure mode this catches: a compose mount that resolves to an empty file, which
    // otherwise reaches GitHub as `Bearer ` and comes back 401 — reported as "the PAT is
    // invalid" when in fact nothing was ever mounted.
    expect(() => readConfig(env(), (p) => (p === "/run/secrets/gw" ? "\n" : read(p))))
      .toThrow(/GATEWAY_KEY_FILE.*empty/i);
  });

  it("defaults gatewayUrl to the bare gateway host — the router route, never the /anthropic pass-through (ORB-225)", () => {
    // The adapter (draft-model.ts) appends /v1/messages itself. A bare default means that
    // lands on the gateway's router route, where purpose aliases (e.g. heiberg-brain) resolve.
    // The old default carried an /anthropic suffix, landing on the pass-through instead, where
    // an alias 404s.
    expect(readConfig(env(), read).gatewayUrl).toBe("https://gateway.example.com");
  });

  it("GATEWAY_URL still overrides the default", () => {
    expect(readConfig(env({ GATEWAY_URL: "https://gw.example.test" }), read).gatewayUrl).toBe(
      "https://gw.example.test",
    );
  });

  it("has NO default for the draft model — model choice is a deploy-time decision", () => {
    // Standing portfolio policy: never name a model in code. A default here would be a model
    // choice made by whoever wrote this file, months before the deploy that uses it.
    const broken = env();
    delete broken["ATLAS_DRAFT_MODEL"];
    expect(() => readConfig(broken, read)).toThrow(/ATLAS_DRAFT_MODEL/);
  });

  it("is OFF and daily by default — a deploy that forgets the env var does not start ticking", () => {
    const c = readConfig(env(), read);
    expect(c.live).toBe(false);
    expect(c.tickMs).toBe(86_400_000);
  });

  it("goes live only on exactly '1'", () => {
    expect(readConfig(env({ ATLAS_SYNC_LIVE: "1" }), read).live).toBe(true);
    for (const v of ["0", "true", "yes", ""]) {
      expect(readConfig(env({ ATLAS_SYNC_LIVE: v }), read).live).toBe(false);
    }
  });

  it("REFUSES a tick interval that is not a positive number", () => {
    // `setInterval(fn, NaN)` fires about every millisecond. A typo in this variable would
    // turn a daily job into a hot loop against GitHub, Notion and the model gateway.
    for (const v of ["daily", "0", "-1", "NaN"]) {
      expect(() => readConfig(env({ ATLAS_SYNC_TICK_MS: v }), read)).toThrow(/ATLAS_SYNC_TICK_MS/);
    }
    expect(readConfig(env({ ATLAS_SYNC_TICK_MS: "3600000" }), read).tickMs).toBe(3_600_000);
  });
});

describe("readSpineToken (ORB-178 / ORB-35 item 4)", () => {
  it("prefers the file, trimmed", () => {
    expect(readSpineToken({ SIGNAL_SPINE_TOKEN_FILE: "/run/secrets/t", SIGNAL_SPINE_TOKEN: "env" }, () => "from-file\n")).toBe("from-file");
  });
  it("falls back to the env var, and to undefined; empty counts as unset", () => {
    expect(readSpineToken({ SIGNAL_SPINE_TOKEN: "env" }, () => { throw new Error("must not read"); })).toBe("env");
    expect(readSpineToken({ SIGNAL_SPINE_TOKEN: "" }, () => "")).toBeUndefined();
    expect(readSpineToken({}, () => "")).toBeUndefined();
  });
  it("a configured file that cannot be read is a deploy error, not silence", () => {
    expect(() => readSpineToken({ SIGNAL_SPINE_TOKEN_FILE: "/run/secrets/missing" }, () => { throw new Error("ENOENT"); })).toThrow(/\/run\/secrets\/missing/);
  });
  it("a configured file that reads blank is REFUSED, not treated as unset — never falls back to the plain env var (fix round 1)", () => {
    expect(() =>
      readSpineToken({ SIGNAL_SPINE_TOKEN_FILE: "/run/secrets/blank", SIGNAL_SPINE_TOKEN: "env" }, () => "   \n"),
    ).toThrow(/\/run\/secrets\/blank/);
  });
});
