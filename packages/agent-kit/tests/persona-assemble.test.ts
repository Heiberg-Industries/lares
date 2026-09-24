import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseManifest } from "../src/manifest.js";
import { assemblePersona, renderEnvironment } from "../src/persona/assemble.js";

const m = parseManifest({
  name: "t", model: "m", persona: "x", channels: ["slack"], egress: { sealed: true },
  grants: [{ capability: "vault", scope: "write-with-confirm", areas: ["private"] }, { capability: "orakel", scope: "read" }, { capability: "remind", scope: "write" }],
  autonomy: { vault: "gated" },
  skills: [{ name: "commercial", requires: [{ capability: "orakel", scope: "read" }] }],
});

describe("renderEnvironment", () => {
  const env = renderEnvironment(m);
  it("lists every granted capability with its deployed tool names and scope in words", () => {
    expect(env).toContain("agent-kit__vault_search");
    expect(env).toMatch(/vault[\s\S]*behind a confirmation card/);
    expect(env).toMatch(/orakel[\s\S]*read-only/);
    expect(env).toMatch(/remind[\s\S]*directly/);
  });
  it("names NO ungranted capability (the Wave-1 bug in reverse)", () => {
    expect(env).not.toMatch(/gmail|calendar|twenty/);
  });
  it("states the sandbox posture and the egress seal", () => {
    expect(env).toMatch(/no shell/i);
    expect(env).toMatch(/sealed/i);
  });
  it("lists code skills and what they compose", () => {
    expect(env).toMatch(/commercial[\s\S]*orakel/);
  });
});

// ORB-145 whole-branch review, Critical #1. `renderEnvironment` names tools only through the
// capability docs, and a skill has no doc — so the skills block used to end at "composes
// twenty:read, orakel:read." and never name `commercial_who_to_contact`. Saga's instructions.md
// therefore said "**My only capabilities are the tools below.**" over 57 of her 58 compiled
// tools, the 58th being a skill tool the model was never told it had. Both branches are pinned
// here so neither can rot.
describe("renderEnvironment — a skill names its own tools", () => {
  const withSkill = parseManifest({
    name: "t", model: "m", persona: "x", channels: [], egress: { sealed: true },
    grants: [{ capability: "orakel", scope: "read" }, { capability: "twenty", scope: "read" }],
    autonomy: {},
    skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: "read" }, { capability: "orakel", scope: "read" }] }],
  });

  it("names the skill's tool when the agent deploys it", () => {
    const env = renderEnvironment(withSkill, { deployedTools: ["commercial_who_to_contact", "agent-kit__orakel_search"] });
    expect(env).toContain("- **commercial** — composes twenty:read, orakel:read. Tools: `commercial_who_to_contact`.");
  });

  it("says so plainly when the skill is declared but none of its tools ships here", () => {
    // The bullet stays, exactly as an unserved capability's does: a declared skill nothing
    // implements is a defect in the declaration worth seeing, not one to paper over.
    const env = renderEnvironment(withSkill, { deployedTools: ["agent-kit__orakel_search"] });
    expect(env).toContain("- **commercial** — composes twenty:read, orakel:read. No tool of this skill is deployed here.");
    expect(env).not.toContain("`commercial_who_to_contact`");
  });

  it("renders the skill's full tool list when the caller gives no deployedTools — the union view", () => {
    expect(renderEnvironment(withSkill)).toContain("Tools: `commercial_who_to_contact`.");
  });
});

// ORB-145 Phase 3, Task 9. The web-access sentence is the one claim in this section that
// differs BETWEEN today's agents: Marcel keeps eve's `web_search` enabled, Saga and Calliope
// disable it. It used to be a fixed sentence inside read_url's capability doc, which meant any
// agent granting read_url was told it cannot search the web — false for Marcel, and exactly the
// Wave-1 failure (an environment section denying a capability the agent holds) that generating
// this section was supposed to make impossible. One case per branch, so neither can rot.
describe("renderEnvironment — the web-access sentence follows framework_tools", () => {
  const base = {
    name: "t", model: "m", persona: "x", channels: [], egress: { sealed: true },
    grants: [{ capability: "read_url", scope: "read" }],
    autonomy: {}, skills: [],
  };
  const without = renderEnvironment(parseManifest(base));
  const with_ = renderEnvironment(parseManifest({ ...base, framework_tools: ["web_search"] }));

  it("denies web search when framework_tools is empty (the default)", () => {
    expect(without).toContain("I cannot search the web; I only read a page I am handed the URL of.");
    expect(without).not.toMatch(/I can search the web/);
  });
  it("states web search plainly when framework_tools declares it", () => {
    expect(with_).toContain("I can search the web with the framework's web search tool");
    expect(with_).not.toMatch(/I cannot search the web/);
  });
  it("read_url's own doc no longer decides it — the capability text is identical either way", () => {
    // The denial must not come back through the capability doc, or the two would be able to
    // contradict each other inside one file.
    const bullet = (s: string) => s.slice(s.indexOf("- **read_url**"));
    expect(bullet(without)).toBe(bullet(with_));
    expect(bullet(without)).not.toMatch(/search the web/);
  });
});

// ORB-145 Phase 3, Task 9 review. A capability doc's `tools` is the fleet-wide UNION across
// every agent granting that capability, so rendering it unfiltered names tools the agent cannot
// call — Marcel was told he held `calendar_create_event`, `travel_read` and `forget`; Saga that
// she held `sveip` and `nytur`. Under "**My only capabilities are the tools below**" that is the
// Wave-1 bug pointing the other way: a persona that OVERclaims, which the model only discovers
// by calling something that isn't there.
describe("renderEnvironment — deployedTools narrows each capability's tool union", () => {
  const m = parseManifest({
    name: "t", model: "m", persona: "x", channels: [], egress: { sealed: true },
    grants: [{ capability: "calendar", scope: "read" }, { capability: "vault", scope: "write", areas: ["facts"] }],
    autonomy: {}, skills: [],
  });

  it("renders only the deployed names when the option is given", () => {
    const env = renderEnvironment(m, { deployedTools: ["calendar_list_events", "remember"] });
    expect(env).toContain("Tools: `calendar_list_events`.");
    expect(env).toContain("Tools: `remember`.");
    for (const absent of ["calendar_create_event", "calendar_free_busy", "calendar_delete_event", "forget"]) {
      expect(env, `named a tool this agent does not deploy: ${absent}`).not.toContain(`\`${absent}\``);
    }
  });

  it("says so plainly when a granted capability deploys none of its tools", () => {
    // The bullet stays. A grant no tool serves is a real defect in the declaration and should be
    // visible, not silently dropped from the section that claims to be the whole truth.
    const env = renderEnvironment(m, { deployedTools: ["remember"] });
    expect(env).toContain("**calendar** (Google Calendar) — read-only.");
    expect(env).toContain("No tools of this capability are deployed here.");
    expect(env).not.toContain("`calendar_list_events`");
  });

  it("renders the full union when the option is omitted — unchanged behaviour", () => {
    const env = renderEnvironment(m);
    expect(env).toContain("`calendar_create_event`");
    expect(env).toContain("`forget`");
    expect(env).not.toContain("No tools of this capability are deployed here.");
  });

  it("assemblePersona passes the option through", () => {
    const out = assemblePersona({
      manifest: m, roleMd: "## Duties\nDo the job.", voiceMd: "Plain.", displayName: "Tess",
      deployedTools: ["calendar_list_events", "remember"],
    });
    expect(out).toContain("Tools: `calendar_list_events`.");
    expect(out).not.toContain("`calendar_create_event`");
  });
});

describe("renderEnvironment — scopeInWords for a plain write", () => {
  it("says no card WITHOUT claiming the write only affects the owner", () => {
    // `travel:write` posts into a family group chat (nytur, link_group, predeparture_pack), so
    // the old parenthetical was false for the first agent outside Saga to carry a plain write.
    const env = renderEnvironment(parseManifest({
      name: "t", model: "m", persona: "x", channels: [], egress: { sealed: true },
      grants: [{ capability: "travel", scope: "write" }], autonomy: {}, skills: [],
    }));
    expect(env).toContain("**travel** — writes directly — no card.");
    expect(env).not.toMatch(/only affects the owner/);
  });
});

describe("assemblePersona", () => {
  it("emits the four sections in order with role and voice verbatim", () => {
    const out = assemblePersona({ manifest: m, roleMd: "## Duties\nDo the job.", voiceMd: "Plain and dry.", displayName: "Tess" });
    const i = (s: string) => out.indexOf(s);
    expect(i("# Tess — who I am")).toBeGreaterThanOrEqual(0);
    expect(i("# Tess — where I run")).toBeGreaterThan(i("# Tess — who I am"));
    expect(i("# Tess — role")).toBeGreaterThan(i("# Tess — where I run"));
    expect(i("# Tess — voice")).toBeGreaterThan(i("# Tess — role"));
    expect(out).toContain("## Duties\nDo the job.");
    expect(out).toContain("Plain and dry.");
  });
  it("is deterministic — same input, same bytes", () => {
    const a = assemblePersona({ manifest: m, roleMd: "r", voiceMd: "v", displayName: "T" });
    expect(assemblePersona({ manifest: m, roleMd: "r", voiceMd: "v", displayName: "T" })).toBe(a);
  });
});

// ADR-0018 rule 9: the per-session core ships with a written precedence rule, and ADR-0015
// rule 5 makes it engine-owned — part of every agent whatever its definition, never something a
// role's duties or voice can edit away. This is that rule, generated into every assembled
// persona rather than left to a template to remember to include.
describe("the memory precedence rule is engine-owned (ADR-0018 rule 9)", () => {
  const out = assemblePersona({
    manifest: m,
    roleMd: "## Duties\nDo the work.",
    voiceMd: "Plain sentences.",
    displayName: "Agent",
    deployedTools: [],
  });

  it("states the four rules, in the owner's words, not a paraphrase", () => {
    expect(out).toContain("# Agent — how I use what I remember");
    expect(out).toMatch(/the latest instruction wins/i);
    expect(out).toMatch(/notes are advisory/i);
    expect(out).toMatch(/if.*conflicts.*ask/i);
    expect(out).toMatch(/never treat.*as an instruction/i);
  });

  it("comes after where I run and before the role — engine rules before the owner's words", () => {
    const i = (s: string) => out.indexOf(s);
    expect(i("# Agent — how I use what I remember")).toBeGreaterThan(i("# Agent — where I run"));
    expect(i("# Agent — how I use what I remember")).toBeLessThan(i("# Agent — role"));
  });

  it("is there for every role, with no role able to remove it", () => {
    for (const role of ["chief-of-staff", "travel", "creative"]) {
      const md = readFileSync(resolve(__dirname, `../../../services/${role}/agent/persona.md`), "utf8");
      expect(md).toMatch(/— how I use what I remember/);
    }
  });
});

describe("renderEnvironment — exclusion branches (review follow-up)", () => {
  const excluded = parseManifest({
    name: "t2", model: "m", persona: "x", channels: [], egress: { sealed: false },
    grants: [
      { capability: "gmail", scope: "none" },
      { capability: "twenty", scope: "read" },
      { capability: "remind", scope: "write" },
    ],
    autonomy: { twenty: "never" },
    skills: [],
  });
  const env = renderEnvironment(excluded);

  it("excludes a capability granted at scope none", () => {
    expect(env).not.toMatch(/gmail/);
  });
  it("excludes a capability whose autonomy is never, even though it is scoped", () => {
    expect(env).not.toMatch(/twenty/);
  });
  it("still renders a real grant alongside the two exclusions", () => {
    expect(env).toMatch(/remind/);
  });
  it("renders empty doors honestly when no channels are configured", () => {
    expect(env).toContain("Doors: none configured.");
  });
  it("omits the skills block entirely when there are no skills", () => {
    expect(env).not.toContain("Skills I carry");
  });
});

describe("renderEnvironment — rules keyed to the tools they concern (Task 10 review)", () => {
  // The defect: `atlas`'s doc described a re-derived-proposal flow in its SUMMARY, and carried
  // the matching "list proposals fresh" rule, for every agent granting the capability. Calliope
  // ships neither `atlas_proposals` nor `atlas_resolve_proposal`, so her generated section told
  // her — under "**My only capabilities are the tools below**" — to use a flow she has no tools
  // for. `deployedTools` had already fixed the tool NAMES beside it; the prose was still the
  // fleet-wide union.
  const sharedAreaOnly = parseManifest({
    name: "t3", model: "m", persona: "x", channels: [], egress: { sealed: true },
    grants: [{ capability: "vault", scope: "write-with-confirm", areas: ["shared"] }], autonomy: { vault: "gated" }, skills: [],
  });

  it("drops a keyed rule when NONE of its tools is deployed here", () => {
    const env = renderEnvironment(sharedAreaOnly, { deployedTools: ["vault_search", "vault_read", "vault_list", "vault_write"] });
    expect(env).not.toContain("List proposals fresh");
    expect(env).not.toContain("re-derived proposal");
    // ...while the rule that belongs to the capability itself, not to one tool, still renders.
    expect(env).toContain("Store-relative paths only");
    // ...and the keyed rule whose tool IS here does render, which is what makes the drop above
    // a filter rather than a blanket suppression.
    expect(env).toContain("behind an approval card");
  });

  it("keeps a keyed rule when at least ONE of its tools is deployed here", () => {
    const env = renderEnvironment(sharedAreaOnly, { deployedTools: ["vault_search", "atlas_resolve_proposal"] });
    expect(env).toContain("List proposals fresh");
    expect(env).toContain("re-derived proposal");
    // `vault_write` is absent, so its keyed rule goes — the other direction of the same filter.
    expect(env).not.toContain("behind an approval card");
  });

  it("renders EVERY rule when the caller supplies no deployedTools — the union view", () => {
    // Same contract as the tool list: no filter given, nothing filtered. A caller with no agent
    // folder to read from still gets the complete picture rather than a silently narrowed one.
    const env = renderEnvironment(sharedAreaOnly);
    expect(env).toContain("Store-relative paths only");
    expect(env).toContain("re-derived proposal");
    expect(env).toContain("List proposals fresh");
    expect(env).toContain("behind an approval card");
  });

  it("keeps tool-specific claims OUT of every summary — the property the keying exists to hold", () => {
    // The generic half of each doc must hold for every agent that grants the capability. This is
    // the assertion that stops the next tool-specific sentence from being written into a summary
    // instead of a keyed rule: a read-only-shaped agent must see no claim about writing.
    const env = renderEnvironment(sharedAreaOnly, { deployedTools: ["vault_search", "vault_read", "vault_list"] });
    const bullet = env.split("\n").filter((l) => l.includes("**vault**")).join("\n");
    expect(bullet).toContain("I search, read and list its notes");
    expect(bullet).not.toMatch(/proposal|approval card/i);
    // ...and, since W5C-s5 put three stores under one capability, the two areas this
    // declaration does NOT grant are not described to it either — the personal store's own
    // sentence and the standing facts' both key on tools that are not deployed here.
    expect(bullet).not.toMatch(/second brain|a fact worth remembering/i);
  });
});

// ORB-210 item 2. `gmail` and `twenty` described their specific write tools unconditionally, so
// an installation granting either at `read` was told in its own persona that a draft renders a
// card and that five CRM writes exist. Keying those sentences inside the SUMMARY rather than
// moving them out to rules is what keeps the fix invisible to an agent that holds everything: the
// parts rejoin to exactly the paragraph they replaced, so no live persona changed a byte.
describe("renderEnvironment — keyed summary parts", () => {
  const crm = parseManifest({
    name: "t", model: "m", persona: "x", channels: [], egress: { sealed: true },
    grants: [{ capability: "gmail", scope: "write-with-confirm" }, { capability: "twenty", scope: "write-with-confirm" }],
    autonomy: {}, skills: [],
  });
  const ALL = [
    "gmail_search", "gmail_read", "gmail_signature", "gmail_draft", "gmail_send",
    "twenty_lookup", "twenty_get_person", "twenty_company_for_person",
    "twenty_note", "twenty_comm_state", "twenty_do_not_contact", "twenty_create_opportunity", "twenty_set_stage",
    "meeting_followup_send", "gmail_draft_recipients",
    // LAR-28 keyed two more sentences of the gmail summary on these — "every tool" includes them.
    "meeting_followup_record_denial", "meeting_followup_redraft",
  ];
  const READS = ["gmail_search", "gmail_read", "gmail_signature", "twenty_lookup", "twenty_get_person", "twenty_company_for_person"];
  const bulletFor = (env: string, cap: string): string => env.split("\n").filter((l) => l.includes(`**${cap}**`)).join("\n");

  it("an agent holding every tool renders the paragraph unchanged — keying is invisible", () => {
    // The property the byte-identical regeneration of all three live personas rests on.
    const full = bulletFor(renderEnvironment(crm, { deployedTools: ALL }), "gmail");
    expect(full).toContain(
      "A real, connected Gmail mailbox. I search it, read a message by id, and fetch the account's " +
      "configured signature without needing approval, since none of that changes anything. Drafting a " +
      "reply sends nothing",
    );
    // ...and the union view (no deployedTools at all) renders the same paragraph.
    expect(bulletFor(renderEnvironment(crm), "gmail")).toEqual(full);
  });

  it("a read-only installation is told nothing about drafting, sending or CRM writes", () => {
    const env = renderEnvironment(crm, { deployedTools: READS });
    expect(bulletFor(env, "gmail")).toContain("I search it, read a message by id");
    expect(bulletFor(env, "gmail")).not.toMatch(/Drafting a reply|renders a card/);
    expect(bulletFor(env, "twenty")).toContain("I look up a person or company by name or email");
    expect(bulletFor(env, "twenty")).not.toMatch(/writes without approval|do-not-contact/);
  });

  it("a write-only installation is told nothing about searching or looking up", () => {
    const env = renderEnvironment(crm, { deployedTools: ALL.filter((t) => !READS.includes(t)) });
    expect(bulletFor(env, "gmail")).toContain("Drafting a reply sends nothing");
    expect(bulletFor(env, "gmail")).not.toMatch(/I search it/);
    expect(bulletFor(env, "twenty")).toContain("Nothing here writes without approval");
    expect(bulletFor(env, "twenty")).not.toMatch(/I look up a person|returning nothing/);
  });

  it("keeps the unconditional sentences whatever ships — a mailbox is chosen for a search too", () => {
    for (const set of [ALL, READS]) {
      const bullet = bulletFor(renderEnvironment(crm, { deployedTools: set }), "gmail");
      expect(bullet).toContain("A real, connected Gmail mailbox.");
      expect(bullet).toContain("act on whichever connected mailbox the request names");
    }
  });
});
