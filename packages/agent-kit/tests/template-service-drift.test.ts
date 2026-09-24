// The role TEMPLATES are the neutral defaults every role service and every overlay is built from
// (repo CLAUDE.md). When a service's own declaration moves and its template does not, an overlay
// authored from the documentation ships broken — and nothing in the repo notices, because no
// test reads both.
//
// That is exactly what ORB-278 step 2's rename nearly did: the persona moved from
// `agent/instructions.md` to `agent/persona.md` in all three services (eve reads a root
// `agent/instructions.md` AND `agent/instructions/` together, so leaving it there injected the
// whole persona twice), while the three templates still said `agent/instructions.md`. An overlay
// built from one would have named a file that does not exist — and "fixing" that by creating
// `agent/instructions.md` reintroduces the double injection.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** role template -> the service that ships it. */
const PAIRS = [
  ["chief-of-staff", "chief-of-staff"],
  ["travel", "travel"],
  ["creative", "creative"],
] as const;

const templates = new URL("../templates", import.meta.url).pathname;
const services = new URL("../../../services", import.meta.url).pathname;

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("role templates do not drift from the services built on them", () => {
  it.each(PAIRS)("%s: the template's persona path is the one the service actually uses", (role, svc) => {
    const template = readJson(`${templates}/${role}/agent.json`);
    const service = readJson(`${services}/${svc}/agent.json`);
    expect(template["persona"]).toBe(service["persona"]);
  });

  it.each(PAIRS)("%s: the template names the assembled artefact, never a path eve also reads", (role) => {
    const template = readJson(`${templates}/${role}/agent.json`);
    // `agent/instructions.md` and `agent/instructions/` are BOTH read by eve, root first. The
    // assembled persona must live outside that pair or it reaches the model twice.
    expect(template["persona"]).toBe("agent/persona.md");
  });

  it.each(PAIRS)("%s: the template's role id matches the service's", (role, svc) => {
    expect(readJson(`${templates}/${role}/agent.json`)["role"] ?? role).toBe(
      readJson(`${services}/${svc}/agent.json`)["role"],
    );
  });

  it("the templates README does not still instruct an overlay to use the old path", () => {
    const readme = readFileSync(`${templates}/README.md`, "utf8");
    expect(readme).not.toMatch(/"persona":\s*"agent\/instructions\.md"/u);
    expect(readme).not.toMatch(/--out agent\/instructions\.md/u);
  });
});
