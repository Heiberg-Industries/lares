import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "install.sh");
const src = readFileSync(SCRIPT, "utf8");
const lines = src.split("\n");

describe("what the installer promises", () => {
  it("names an undo beside every step that destroys something", () => {
    const destructive = /(^|\s)(rm -rf|docker (compose )?(down|rm)|DROP (DATABASE|TABLE)|mkfs|dd |truncate)/;
    const offenders = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => destructive.test(line) && !line.trimStart().startsWith("#"))
      .filter(({ i }) => !/^\s*#\s*undo:/.test(lines[i - 1] ?? ""));
    expect(offenders.map(({ line, i }) => `${i + 1}: ${line.trim()}`)).toEqual([]);
  });

  // EVERY HOST THIS SCRIPT NAMES, AND WHY IT IS ALLOWED TO. A new one has to be added here with
  // a reason, in the open. The rule is deliberately a text scan, so the honest way past it is to
  // widen this list and say why — never to split a URL across variables until the regex stops
  // matching it, which leaves the rule with a hole and the next reader with a puzzle.
  const ALLOWED_HOSTS = new Map([
    ["ghcr.io", "the image registry CI publishes to; the registry is a setting, and this is the default"],
    ["127.0.0.1", "this machine, reaching the database the stack published a port for"],
    ["localhost", "the same, by name"],
    ["lares-gateway", "the model gateway's compose service name on the fleet's OWN docker network (owner decision C1) — not a public host, and not reachable from outside this installation"],
  ]);

  // Nothing here is an outside host a person is told to fetch from, either: when docker is
  // missing, the script names the distribution's own package command, not a URL piped into a
  // shell — an installer that promises to download nothing should not advise it either.
  it("reaches no host but the ones named, each for a reason written down", () => {
    const hosts = [...src.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]!);
    const unexplained = hosts.filter(
      (h) => !ALLOWED_HOSTS.has(h) && !h.includes("${") && !h.endsWith(".example.invalid"),
    );
    expect(unexplained).toEqual([]);
  });

  it("downloads nothing, so a host it merely names cannot become a host it runs", () => {
    // The promise the host rule above is a proxy for. `curl` itself is allowed (a later slice
    // asks the console whether it is up); fetching a file, or piping a fetch into a shell, is not.
    const downloads = lines
      .map((line, i) => ({ line: line.trim(), i }))
      .filter(({ line }) => !line.startsWith("#"))
      .filter(({ line }) =>
        /\bwget\b/.test(line) ||
        /\bcurl\b[^|]*\|\s*(ba)?sh\b/.test(line) ||
        /\bcurl\b[^\n]*\s-[a-zA-Z]*[oO]\b/.test(line),
      );
    expect(downloads.map(({ line, i }) => `${i + 1}: ${line}`)).toEqual([]);
  });

  it("pulls every image by digest, never by a tag", () => {
    for (const m of src.matchAll(/(ghcr\.io\/[a-z0-9./_-]+)(@sha256:[a-f0-9]{64}|:[A-Za-z0-9._-]+)?/g)) {
      expect(m[2] ?? "", m[0]).toMatch(/^@sha256:[a-f0-9]{64}$/);
    }
    expect(src).not.toMatch(/docker (compose )?pull\b(?![^\n]*@sha256:)/);
  });

  it("never builds on the box", () => {
    expect(src).not.toMatch(/docker build|pnpm install(?![^\n]*--frozen)|eve build/);
  });

  it("never writes a secret anywhere but the secrets directory, and never echoes one", () => {
    expect(src).not.toMatch(/echo .*\$\{?(TOKEN_ENC_KEY|MODEL_KEY|DB_PASSWORD|GATEWAY_KEY)/);
    for (const m of src.matchAll(/^\s*lares_secret\s+(\S+)/gm)) {
      expect(src).toContain(`$SECRETS_DIR/${m[1]}`);
    }
  });

  it("says in its own header that it never phones home", () => {
    expect(src.slice(0, 2000)).toMatch(/phones? home/i);
  });
});
