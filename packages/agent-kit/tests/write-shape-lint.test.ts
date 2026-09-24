// The write-shape lint (ORB-199). Two layers, tested separately:
//
//   classifyWriteShape — the pure pattern set over ONE file's source. Every exemption below
//   quotes the SHAPE of a real file in this repo; the file:line evidence for each lives in
//   `src/write-shape-lint.ts`'s header, and the fleet-wide "zero findings today" assertion
//   lives in each service's own tests/agent-declaration.test.ts, which runs the lint against
//   its real agent.json and its real tool files.
//
//   lintWriteShape / assertNoUngatedWrites — the tool -> capability -> grant join. Driven here
//   through `resolveSource` and `toolNames` so the cases are synthetic and readable; the real
//   filesystem walk is what the service suites exercise.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyWriteShape,
  lintWriteShape,
  assertNoUngatedWrites,
  capabilitiesForTool,
  isDisabledSentinel,
  sourcesForTool,
  stripComments,
  type ToolSource,
} from "../src/write-shape-lint.js";
import { parseManifest, type AgentManifest } from "../src/manifest.js";

function manifestWith(grants: Array<{ capability: string; scope: string; areas?: string[] }>, extra: Record<string, unknown> = {}): AgentManifest {
  return parseManifest({ name: "t", model: "m", persona: "agent/instructions.md", grants, ...extra });
}

const sources = (source: string): ToolSource[] => [{ file: "tool.ts", source }];

// ---------------------------------------------------------------------------
// (a) + (b) — the whole point: the same tool, two grants, two outcomes
// ---------------------------------------------------------------------------

// `network_person` is a real tool in CAPABILITY_DOCS under the `network` capability, so the
// tool -> capability half of the join is the production one; only the source is synthetic.
const MUTATING_TOOL = `
import { defineTool } from "eve/tools";
export default defineTool({
  description: "Create a widget",
  async execute({ name }) {
    const res = await fetch("https://api.vendor.example/v1/widgets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return res.json();
  },
});
`;

describe("a mutating tool meets its grant", () => {
  it("(a) FAILS under a read grant", () => {
    const findings = lintWriteShape({
      agentDir: "/nowhere",
      manifest: manifestWith([{ capability: "network", scope: "read" }]),
      toolNames: ["network_person"],
      resolveSource: () => sources(MUTATING_TOOL),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "ungated-write",
      tool: "network_person",
      capability: "network",
      scope: "read",
      rule: "http-mutation",
    });
  });

  it("(b) PASSES under write-with-confirm — and under a plain write, which outranks it", () => {
    for (const scope of ["write-with-confirm", "write"]) {
      expect(
        lintWriteShape({
          agentDir: "/nowhere",
          manifest: manifestWith([{ capability: "network", scope }]),
          toolNames: ["network_person"],
          resolveSource: () => sources(MUTATING_TOOL),
        }),
      ).toEqual([]);
    }
  });

  it("assertNoUngatedWrites throws naming the tool, the capability, the scope and the line", () => {
    expect(() =>
      assertNoUngatedWrites({
        agentDir: "/nowhere",
        label: "eve-test",
        manifest: manifestWith([{ capability: "network", scope: "read" }]),
        toolNames: ["network_person"],
        resolveSource: () => sources(MUTATING_TOOL),
      }),
    ).toThrow(/eve-test[\s\S]*network_person[\s\S]*network @ read[\s\S]*http-mutation[\s\S]*tool\.ts:7/);
  });

  it("says nothing when there are no findings", () => {
    expect(() =>
      assertNoUngatedWrites({
        agentDir: "/nowhere",
        manifest: manifestWith([{ capability: "network", scope: "read" }]),
        toolNames: ["network_person"],
        resolveSource: () => sources("export default defineTool({ async execute() { return 1; } });"),
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (c) — a GraphQL query is a read, even though it is a POST
// ---------------------------------------------------------------------------

describe("read-shaped POSTs", () => {
  it("(c) a GraphQL `query` body is read-shape", () => {
    // The shape of packages/agent-kit/src/entur-client.ts:566-570.
    const src = `
      const TRIP_QUERY = \`query trip($from: Location!) { trip(from: $from) { tripPatterns { duration } } }\`;
      async function plan(args) {
        return doFetch(JOURNEY_PLANNER_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: TRIP_QUERY, variables: args }),
        });
      }
    `;
    expect(classifyWriteShape(src)).toEqual([]);
  });

  it("but a GraphQL `mutation` body is write-shape, twice over", () => {
    const src = `
      const M = \`mutation createNote($t: String!) { createNote(title: $t) { id } }\`;
      await doFetch(GRAPHQL_URL, { method: "POST", body: JSON.stringify({ query: M }) });
    `;
    const rules = classifyWriteShape(src).map((f) => f.rule);
    expect(rules).toContain("graphql-mutation");
    expect(rules).toContain("http-mutation");
  });

  it("a search endpoint reached through a transport helper named for its verb is read-shape", () => {
    // The shape of services/travel/lib/google-places.ts:79-93: the POST sits in a helper
    // called `post`; only its callers — searchText, searchNearby — say what it is for.
    const src = `
      const BASE = "https://places.googleapis.com/v1";
      async function post(path, body) {
        const res = await fetchFn(\`\${BASE}/\${path}\`, {
          method: "POST",
          headers: { "X-Goog-Api-Key": key },
          body: JSON.stringify(body),
        });
        return res.json();
      }
      async function searchText(q) { return post("places:searchText", { textQuery: q }); }
      async function searchNearby(p) { return post("places:searchNearby", { center: p }); }
    `;
    expect(classifyWriteShape(src)).toEqual([]);
  });

  it("a URL constant naming a read endpoint is read-shape", () => {
    // The shapes of readability-client.ts:74 (/extract), nearby.ts:41 (overpass interpreter),
    // polymarket-clob-client.ts:34 (/prices) and strava.ts:61 (oauth token refresh).
    for (const url of [
      `const U = "https://readability.example/extract";`,
      `const U = "https://overpass-api.de/api/interpreter";`,
      `const U = "https://clob.polymarket.com/prices";`,
      `const U = "https://www.strava.com/oauth/token";`,
      `const U = "https://gateway.example/v1/embeddings";`,
    ]) {
      expect(classifyWriteShape(`${url}\nawait fetch(U, { method: "POST", body: b });`)).toEqual([]);
    }
  });

  it("a write token in the call vetoes the read-endpoint exemption", () => {
    const src = `
      const U = "https://api.vendor.example/search/create";
      await fetch(U, { method: "POST", body: b });
    `;
    expect(classifyWriteShape(src).map((f) => f.rule)).toEqual(["http-mutation"]);
  });

  it("PUT, PATCH and DELETE are write-shape with no exemption — even at a read-named endpoint", () => {
    for (const verb of ["PUT", "PATCH", "DELETE"]) {
      const src = `await fetch("https://api.vendor.example/search", { method: "${verb}" });`;
      expect(classifyWriteShape(src).map((f) => f.rule)).toEqual(["http-mutation"]);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) — the agent's own door is not a write (the 2026-09-01 sweep's lesson)
// ---------------------------------------------------------------------------

describe("the agent's own door is not write-shape", () => {
  it("(d) a Telegram send is not write-shape", () => {
    // The shape of services/travel/lib/telegram-photo.ts:120.
    const src = `
      const base = "https://api.telegram.org";
      await fetchFn(\`\${base}/bot\${token}/sendPhoto\`, { method: "POST", body: form });
      await fetchFn(\`\${base}/bot\${token}/sendMessage\`, { method: "POST", body: JSON.stringify(m) });
    `;
    expect(classifyWriteShape(src)).toEqual([]);
  });

  it("a Slack chat.postMessage is not write-shape", () => {
    const src = `await fetch("https://slack.com/api/chat.postMessage", { method: "POST", body: b });`;
    expect(classifyWriteShape(src)).toEqual([]);
  });

  it("a channel `.send(` is not a vendor mutation, but Gmail's is", () => {
    // services/travel/lib/bookings.ts:767 is `this.deps.tg.send(...)` — two member segments,
    // exactly like Gmail's `api.users.messages.send(` at services/chief-of-staff/lib/google.ts:241.
    expect(classifyWriteShape(`await this.deps.tg.send(adminId, "hei");`)).toEqual([]);
    expect(classifyWriteShape(`await api.users.messages.send({ userId: "me" });`).map((f) => f.rule)).toEqual([
      "vendor-mutation",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (e) — an unmapped tool
// ---------------------------------------------------------------------------

describe("the tool -> capability map", () => {
  it("(e) a tool no capability doc claims is a finding", () => {
    const findings = lintWriteShape({
      agentDir: "/nowhere",
      manifest: manifestWith([{ capability: "network", scope: "read" }]),
      toolNames: ["widget_frobnicate"],
      resolveSource: () => sources("export default defineTool({});"),
    });
    expect(findings).toEqual([{ kind: "unmapped-tool", tool: "widget_frobnicate" }]);
  });

  it("its message says what to do about it", () => {
    expect(() =>
      assertNoUngatedWrites({
        agentDir: "/nowhere",
        manifest: manifestWith([]),
        toolNames: ["widget_frobnicate"],
        resolveSource: () => sources("export default defineTool({});"),
      }),
    ).toThrow(/widget_frobnicate: no capability doc lists this tool/);
  });

  it("a capability doc's tool maps to its capability, and a skill's tool to the skill", () => {
    expect(capabilitiesForTool("network_person")).toEqual(["network"]);
    expect(capabilitiesForTool("commercial_who_to_contact")).toEqual(["skill:commercial"]);
    expect(capabilitiesForTool("nothing_claims_me")).toEqual([]);
  });

  it("a skill's tool is authorised by the capabilities the skill composes", () => {
    const manifest = manifestWith(
      [
        { capability: "twenty", scope: "write-with-confirm" },
        { capability: "orakel", scope: "read" },
      ],
      {
        skills: [
          {
            name: "commercial",
            requires: [
              { capability: "twenty", scope: "read" },
              { capability: "orakel", scope: "read" },
            ],
          },
        ],
      },
    );
    // twenty is write-class, so a write-shaped commercial tool is authorised.
    expect(
      lintWriteShape({
        agentDir: "/nowhere",
        manifest,
        toolNames: ["commercial_who_to_contact"],
        resolveSource: () => sources(MUTATING_TOOL),
      }),
    ).toEqual([]);
  });

  it("an eve FRAMEWORK tool has no grant to check and is skipped", () => {
    // services/travel/agent/tools/web_search.ts — declared in Marcel's `framework_tools`.
    // manifest.ts: framework tools "are NOT capabilities and NOT grants".
    expect(
      lintWriteShape({
        agentDir: "/nowhere",
        manifest: manifestWith([], { framework_tools: ["web_search"] }),
        toolNames: ["web_search"],
        resolveSource: () => sources(MUTATING_TOOL),
      }),
    ).toEqual([]);
  });

  it("a disableTool() sentinel is not a tool, so it is neither classified nor mapped", () => {
    expect(isDisabledSentinel(`import { disableTool } from "eve/tools";\nexport default disableTool();`)).toBe(true);
    expect(isDisabledSentinel(`// the same code is a disableTool() sentinel there\nexport default tool;`)).toBe(false);
    expect(
      lintWriteShape({
        agentDir: "/nowhere",
        manifest: manifestWith([]),
        toolNames: ["bash"],
        resolveSource: () => null,
      }),
    ).toEqual([]);
  });

  it("an ungranted capability disables the tool at build time, so it is not an ungated write", () => {
    // resolveExtensionTool returns a disableTool() sentinel for an ungranted or `none` scope —
    // eve-calliope ships all twelve kit tool files and mounts none of them.
    expect(
      lintWriteShape({
        agentDir: "/nowhere",
        manifest: manifestWith([{ capability: "network", scope: "none" }]),
        toolNames: ["network_person"],
        resolveSource: () => sources(MUTATING_TOOL),
      }),
    ).toEqual([]);
  });

  it("a skip entry keeps a known finding out of the red", () => {
    expect(
      lintWriteShape({
        agentDir: "/nowhere",
        manifest: manifestWith([{ capability: "network", scope: "read" }]),
        toolNames: ["network_person"],
        skip: { network_person: "known, tracked in ORB-xxx" },
        resolveSource: () => sources(MUTATING_TOOL),
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (f) — SQL writes, including multi-line template strings
// ---------------------------------------------------------------------------

describe("SQL writes", () => {
  it("(f) finds a write in a multi-line template string, at the line the keyword is on", () => {
    const src = [
      "await pool.query(",
      "  `",
      "    INSERT INTO reminders (id, body)",
      "    VALUES ($1, $2)",
      "    ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body",
      "  `,",
      "  [id, body],",
      ");",
    ].join("\n");
    const found = classifyWriteShape(src);
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe("sql-write");
    expect(found[0]!.line).toBe(3);
  });

  it("finds UPDATE … SET, DELETE FROM and UPSERT", () => {
    for (const sql of [
      "UPDATE standing_facts SET body = $1 WHERE id = $2",
      "DELETE FROM reminders WHERE id = $1",
      "select upsert_market($1)",
    ]) {
      expect(classifyWriteShape(`await pool.query(\`${sql}\`);`).map((f) => f.rule)).toEqual(["sql-write"]);
    }
  });

  it("does not read a SELECT as a write", () => {
    const src = "await pool.query(`SELECT id, body FROM reminders WHERE user_id = $1 ORDER BY due_at`);";
    expect(classifyWriteShape(src)).toEqual([]);
  });

  it("does not read SQL keywords in PROSE as a write — comments are stripped first", () => {
    // packages/agent-kit/src/markets/types.ts:7 names "Upsert/RecordMatch/…" in a comment; this
    // repo's files carry long explanatory headers that talk about writes constantly.
    const src = [
      "// The write verbs (Upsert/RecordMatch/Snapshot) are deliberately absent: this is a read.",
      "/* We never INSERT INTO markets here — the producer does that. */",
      "export const read = true;",
    ].join("\n");
    expect(classifyWriteShape(src)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The remaining rules and the exclusions that keep them honest
// ---------------------------------------------------------------------------

describe("vendor mutations, write helpers and fs writes", () => {
  it("needs TWO member segments, so an in-memory collection's .delete is not a vendor call", () => {
    // notes-store.ts:135 (`CONTENT_CACHE.delete(abs)`), live-location.ts:60 (`store.delete(id)`),
    // google-auth.ts:94 (`decipher.update(ct)`) — all one segment, all reachable from read tools.
    expect(classifyWriteShape("CONTENT_CACHE.delete(abs);")).toEqual([]);
    expect(classifyWriteShape("store.delete(chatId);")).toEqual([]);
    expect(classifyWriteShape("Buffer.concat([decipher.update(ct), decipher.final()]);")).toEqual([]);
    expect(classifyWriteShape("await api.events.insert({ calendarId });").map((f) => f.rule)).toEqual([
      "vendor-mutation",
    ]);
  });

  it("finds a named write helper, including through TypeScript type arguments", () => {
    // services/chief-of-staff/agent/tools/twenty_create_opportunity.ts:39.
    expect(classifyWriteShape(`await twentyPost<unknown>("/opportunities", payload);`).map((f) => f.rule)).toEqual([
      "write-helper",
    ]);
    expect(classifyWriteShape(`await commitNote({ vaultRoot, path, content });`).map((f) => f.rule)).toEqual([
      "write-helper",
    ]);
  });

  it("does not count a helper's own DECLARATION as a call", () => {
    // Without this, twenty-client.ts's `export function twentyPost` taints twenty_lookup and
    // twenty_get_person — pure reads that import the module and only call twentyGet.
    expect(classifyWriteShape("export function twentyPost<T = unknown>(path: string, body: unknown) { return 1; }")).toEqual(
      [],
    );
    expect(classifyWriteShape("export async function commitNote(opts) { return 1; }")).toEqual([]);
  });

  it("accepts an extra write helper per call site", () => {
    expect(classifyWriteShape("await vendorCreate(x);", { writeHelpers: ["vendorCreate"] }).map((f) => f.rule)).toEqual([
      "write-helper",
    ]);
  });

  it("counts an fs write only inside the note store — a container-local file is not a third party", () => {
    // services/travel/lib/trip-store.ts:88-175 and agent/tools/strava_routes.ts:93-94 are
    // both container-local, and both are reached from `read`-granted tools.
    expect(classifyWriteShape(`fs.writeFileSync(path.join(trip.dir, file), content);`)).toEqual([]);
    const inStore = `
      import { resolveInStore } from "./notes-store.js";
      const abs = resolveInStore(relPath, vaultRoot);
      writeFileSync(abs, bytes);
    `;
    expect(classifyWriteShape(inStore).map((f) => f.rule)).toEqual(["store-fs-write"]);
  });
});

describe("stripComments keeps offsets exact", () => {
  it("blanks comments without moving a single line or column", () => {
    const src = 'const a = 1; // INSERT INTO x\nconst b = "INSERT INTO y";\n';
    const { code } = stripComments(src);
    expect(code).toHaveLength(src.length);
    expect(code.split("\n")).toHaveLength(src.split("\n").length);
    expect(code).toContain('const b = "INSERT INTO y"');
    expect(code).not.toContain("// INSERT INTO x");
  });

  it("does not read a regex literal's slashes as a comment", () => {
    const src = 'const re = /\\/\\//g;\nawait pool.query(`DELETE FROM t`);';
    expect(classifyWriteShape(src).map((f) => f.rule)).toEqual(["sql-write"]);
  });
});

describe("the depth rule", () => {
  it("reads the tool file plus what it imports directly, and no further", () => {
    // Run against the real tree. Task 9 (ORB-278 step 2) moved chief-of-staff's `read_url` out
    // of `agent/tools/` and into her own `catalogue/` — same tool, same one-hop shape, new home
    // (`sourcesForTool`'s own "local" candidate list already looks in both, exactly for this).
    // The catalogue file still imports @lares/agent-kit/readability-client, one hop, plus three
    // of her own relative libs (notion-page.js, google-doc.js, google-drive.js) reading a Notion
    // or Google Docs link instead. One of those, google-drive.js, imports
    // @lares/agent-kit/google-auth — a REAL two-hop dependency from the tool file, which is what
    // proves "and no further" rather than just asserting it in prose.
    const found = sourcesForTool(new URL("../../../services/chief-of-staff", import.meta.url).pathname, "read_url");
    expect(found).not.toBeNull();
    const files = found!.map((s) => s.file);
    expect(files.some((f) => f.endsWith("/catalogue/read_url.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/src/readability-client.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/src/google-auth.ts"))).toBe(false);
  });

  it("treats a service's extension re-export as a re-export, not a hop — the kit body joins it", () => {
    // NOT chief-of-staff any more: Task 9 (ORB-278 step 2) moved her `agent-kit__transit_plan`
    // into her own catalogue and turned THIS EXACT mount into an unconditional `disableTool()`
    // sentinel — the same shape Task 8 already gave travel's copy, which the "resolves a
    // prefixed tool from the SERVICE'S OWN CATALOGUE…" case just below this one already covers
    // (using travel's tree). Creative is the one service left that has not made that move for
    // any agent-kit-prefixed tool — her `catalogue/` holds only her own authored tools
    // (atlas_*, set_language, studio_ideate; no `agent-kit__*` entries at all) — so her
    // `agent/extensions/agent-kit/tools/transit_plan.ts` mount is still a genuinely LIVE,
    // unmoved re-export (`resolveExtensionTool(manifest, "transit", transit_plan)`, not a
    // `disableTool()` sentinel — the depth rule's static read does not care that Calliope's own
    // `agent.json` never grants "transit" and so never actually exposes it at runtime; the lint
    // inspects reachable CODE, not what one agent's declaration happens to grant today), which
    // is exactly the shape this test's premise needs.
    const found = sourcesForTool(
      new URL("../../../services/creative", import.meta.url).pathname,
      "agent-kit__transit_plan",
    );
    expect(found).not.toBeNull();
    const files = found!.map((s) => s.file);
    expect(files.some((f) => f.endsWith("/agent/extensions/agent-kit/tools/transit_plan.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/extension/tools/transit_plan.ts"))).toBe(true);
    // entur-client is imported by the kit body — one hop from it.
    expect(files.some((f) => f.endsWith("/src/entur-client.ts"))).toBe(true);
  });

  it("returns null for a disableTool() sentinel", () => {
    expect(sourcesForTool(new URL("../../../services/chief-of-staff", import.meta.url).pathname, "bash")).toBeNull();
  });

  it(
    "resolves a prefixed tool from the SERVICE'S OWN CATALOGUE when the mount is a disabled " +
      "sentinel (ORB-278 step 2, Task 8) — not from the now-dead mount",
    () => {
      // eve-marcel's real, committed shape: agent/extensions/agent-kit/tools/transit_plan.ts is
      // an unconditional disableTool() (Task 8), and agent-kit__transit_plan is answered instead
      // from services/travel/catalogue/agent-kit__transit_plan.ts. Before the fix this returned
      // `null` — "disabled, skip" — because sourcesForTool only ever looked at the mount.
      const found = sourcesForTool(new URL("../../../services/travel", import.meta.url).pathname, "agent-kit__transit_plan");
      expect(found).not.toBeNull();
      const files = found!.map((s) => s.file);
      expect(files.some((f) => f.endsWith("/catalogue/agent-kit__transit_plan.ts"))).toBe(true);
      // The kit body still joins at depth 0, exactly as it does when the mount itself is live —
      // a thin re-export is a thin re-export whichever directory it sits in.
      expect(files.some((f) => f.endsWith("/extension/tools/transit_plan.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("/src/entur-client.ts"))).toBe(true);
    },
  );

  describe("a moved prefixed tool is still inspected by the write-shape lint", () => {
    // THE REGRESSION THIS GUARDS (review follow-up on Task 8). Before the fix above,
    // `sourcesForTool(agentDir, "agent-kit__vault_write")` returned `null` the moment a service
    // turned vault_write's MOUNT into an unconditional disableTool() and answered the key from
    // its own catalogue instead — exactly Task 8's shape, applied to a tool that actually writes.
    // `lintWriteShape` treats `null` as "not a tool, skip", so the ungated-write check went
    // completely blind on the one class of tool it exists to watch: a moved, GATED,
    // vault-writing tool. This fixture reproduces that shape with a REAL kit tool
    // (`packages/agent-kit/extension/tools/vault_write.ts`, which really does call `commitNote`)
    // so the finding below is genuine, not asserted against a synthetic stand-in.
    let agentDir: string;

    function makeFixture(): string {
      const dir = mkdtempSync(join(tmpdir(), "write-shape-lint-catalogue-"));
      mkdirSync(join(dir, "agent", "extensions", "agent-kit", "tools"), { recursive: true });
      mkdirSync(join(dir, "catalogue"), { recursive: true });
      writeFileSync(
        join(dir, "agent", "extensions", "agent-kit", "tools", "vault_write.ts"),
        'import { disableTool } from "eve/tools";\nexport default disableTool();\n',
      );
      writeFileSync(
        join(dir, "catalogue", "agent-kit__vault_write.ts"),
        'import { vault_write } from "@lares/agent-kit/tools";\nexport default vault_write;\n',
      );
      return dir;
    }

    afterEach(() => {
      if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    });

    it("sourcesForTool finds the catalogue re-export and joins the real kit body — not null", () => {
      agentDir = makeFixture();
      const found = sourcesForTool(agentDir, "agent-kit__vault_write");
      expect(found).not.toBeNull();
      const files = found!.map((s) => s.file);
      expect(files.some((f) => f.endsWith("/catalogue/agent-kit__vault_write.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("/extension/tools/vault_write.ts"))).toBe(true);
    });

    it("lintWriteShape reports the real ungated write — it would report NOTHING if sourcesForTool went back to null", () => {
      agentDir = makeFixture();
      const findings = lintWriteShape({
        agentDir,
        manifest: manifestWith([{ capability: "vault", scope: "read", areas: ["private"] }]),
        toolNames: ["agent-kit__vault_write"],
      });
      // Not `toEqual([one thing])`: the real kit body's one-hop import (`../../src/vault-git.js`)
      // carries its own fs write inside `commitNote`, so the real answer is TWO findings for
      // this one tool, not one — asserting an exact single-object shape here would just be a
      // second, brittle copy of whatever `commitNote` happens to do today. What this test exists
      // to pin is the REGRESSION: before the fix, `sourcesForTool` returned `null` for this tool
      // and `findings` was `[]`. Every finding below is for `agent-kit__vault_write` under
      // `vault`, and there is at least one.
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding).toMatchObject({ kind: "ungated-write", tool: "agent-kit__vault_write", capability: "vault" });
      }
    });
  });
});
