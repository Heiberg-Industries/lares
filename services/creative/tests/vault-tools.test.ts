/**
 * Her five tools, proven through their real `execute` against a real temp Atlas.
 *
 * The task brief asked for these guarantees as a source-text grep — reading each tool file and
 * asserting it CONTAINS `"approval: always("` and `"assertApprover"`. That is brittle in both
 * directions: it passes on a commented-out gate and fails on a reformat. Every guarantee below
 * is asserted on the imported tool OBJECT or on real behaviour instead.
 *
 * The ONE exception is the last block. "No file in this service reaches the Brain" is an
 * assertion about an ABSENCE across files, not a property of any object — a grep is the right
 * tool for it, and the only one that can see a file nothing imports.
 *
 * Division of labour with the two neighbouring files, so none of the three is a copy:
 *   - tests/agent-declaration.test.ts — which tools are gated, and whether that matches
 *     agent.json. Structure.
 *   - tests/approvals.test.ts — the allowlist primitives in isolation.
 *   - this file — the tools actually behaving that way when called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UnauthorizedApproverError } from "../lib/approvals.js";
import vaultSearch from "../catalogue/vault_search.js";
import vaultRead from "../catalogue/vault_read.js";
import vaultList from "../catalogue/vault_list.js";
import vaultWrite from "../catalogue/vault_write.js";
import studioIdeate from "../catalogue/studio_ideate.js";

const BENDIK = "U_EXAMPLE_OWNER";
const SOMEONE_ELSE = "U0BADBADBAD";

/** The shape eve's Slack channel builds (`buildSlackAuthContext` in the bundled dist):
 *  authenticator "slack-webhook", the user id under `attributes.user_id`. */
function slackAuth(userId: string) {
  return {
    attributes: { user_id: userId, channel_id: "D123", thread_ts: "1.0" },
    authenticator: "slack-webhook",
    principalId: `slack:T1:${userId}`,
    principalType: "user",
  };
}

function ctx(auth: unknown) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

let tmp: string;
let atlasRoot: string;
let bareDir: string;

beforeEach(() => {
  // A REAL git working clone with a real bare origin, because `vault_write` commits and pushes
  // — a fake root would prove the tool ran and nothing about whether the write survives.
  tmp = mkdtempSync(join(tmpdir(), "eve-calliope-atlas-"));
  bareDir = join(tmp, "atlas.git");
  atlasRoot = join(tmp, "atlas");
  execFileSync("git", ["init", "--quiet", "--bare", bareDir]);
  execFileSync("git", ["clone", "--quiet", bareDir, atlasRoot]);
  git(atlasRoot, "config", "user.email", "test-suite@example.com");
  git(atlasRoot, "config", "user.name", "Test Suite");

  mkdirSync(join(atlasRoot, "ventures"), { recursive: true });
  writeFileSync(
    join(atlasRoot, "ventures", "zero7.md"),
    "---\ntitle: Zero7\n---\n\nZero7 sells agent infrastructure to Norwegian mid-market firms.\n",
    "utf8",
  );
  git(atlasRoot, "add", "--", "ventures/zero7.md");
  git(atlasRoot, "commit", "-q", "-m", "seed");
  git(atlasRoot, "push", "-q", "origin", "HEAD");

  process.env["ATLAS_PATH"] = atlasRoot;
  process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK;
  // Deliberately set, and deliberately pointed somewhere else: the reads below must resolve
  // ATLAS_PATH, never VAULT_PATH. If a tool were ever built with `storeRoot("brain")` this
  // would make the mistake visible rather than throwing a not-configured error that looks like
  // an environment problem.
  process.env["VAULT_PATH"] = join(tmp, "definitely-not-the-brain");
  mkdirSync(process.env["VAULT_PATH"], { recursive: true });
  writeFileSync(join(process.env["VAULT_PATH"], "private.md"), "# Bendik's private note about zero7\n", "utf8");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env["ATLAS_PATH"];
  delete process.env["SLACK_ALLOWED_USER_IDS"];
  delete process.env["VAULT_PATH"];
});

describe("the reads are UNGATED and read the shared area", () => {
  it("carry no approval — a gate on a read trains people to tap without reading", () => {
    for (const [name, tool] of [
      ["vault_search", vaultSearch],
      ["vault_read", vaultRead],
      ["vault_list", vaultList],
    ] as const) {
      expect(tool.approval, `${name} must not be gated`).toBeUndefined();
    }
  });

  it("search and read resolve ATLAS_PATH, not VAULT_PATH", async () => {
    // The temp Brain contains a note that also matches "zero7". Finding only the Atlas one is
    // the assertion: it proves which env var the kit factory closed over.
    //
    // Read as a schedule turn (`auth.current` null): since the multi-user substrate (2026-09-01)
    // a turn WITH a speaker resolves them against the identity registry, which needs the box
    // Postgres and fails closed without it — that path is agent-kit's to test
    // (tests/note-tools-reader.test.ts), not this file's. The assertion here is about paths.
    const found = (await vaultSearch.execute({ area: "shared", q: "zero7 agent infrastructure" }, ctx(null))) as {
      hits: string[];
      files: number;
    };
    expect(found.hits).toEqual(["ventures/zero7.md"]);
    expect(found.files).toBe(1);

    const note = (await vaultRead.execute({ area: "shared", path: "ventures/zero7.md" }, ctx(null))) as {
      content: string;
    };
    expect(note.content).toContain("Norwegian mid-market");
    expect(note.content).not.toContain("private note");
  });

  it("list returns the store-relative index", async () => {
    const listed = (await vaultList.execute({ area: "shared" }, ctx(slackAuth(BENDIK)))) as { notes: string[]; files: number };
    expect(listed.notes).toEqual(["ventures/zero7.md"]);
    expect(listed.files).toBe(1);
  });

  it("refuses a path that escapes the store, even for an allowlisted caller", async () => {
    // ORB-52 containment, inherited from the kit's `resolveInStore`. Asserted here because
    // these three tools are the only file-reaching surface she has: eve's own read_file/glob/
    // grep are disabled (tests/tool-harness.test.ts), on the grounds that these cover the need
    // without exposing absolute paths like /run/secrets.
    await expect(
      vaultRead.execute({ area: "shared", path: "../../etc/passwd" }, ctx(slackAuth(BENDIK))),
    ).rejects.toThrow();
  });

  // W5C-s3, and the reason one tool for every area does not widen anything: the area is an
  // INPUT now, so "she cannot reach the personal store" stopped being a property of which
  // factory argument a file passed and became a property of her DECLARATION. Her agent.json
  // grants the shared store and not the personal one, so `lib/vault-areas.ts` hands the tool
  // the shared area alone and the private one is refused by name. This is the code half of the
  // same rule the last block in this file greps for.
  it("refuses the private area — her declaration grants the shared one and nothing else", async () => {
    for (const [name, tool] of [
      ["vault_search", vaultSearch],
      ["vault_read", vaultRead],
      ["vault_list", vaultList],
    ] as const) {
      await expect(
        (tool.execute as (i: unknown, c: unknown) => Promise<unknown>)(
          { area: "private", q: "anything", path: "private.md" },
          ctx(slackAuth(BENDIK)),
        ),
        `${name} must refuse the private area`,
      ).rejects.toThrow(/private/);
    }
  });
});

describe("the gated tools re-check the approver", () => {
  // eve's own docs: built-in HITL buttons are handled BEFORE `onInteraction`, and "anyone who
  // can interact with the Slack message can answer it". So the click that authorises a write
  // never walks the inbound allowlist, and the re-check inside the tool is the only thing
  // standing between a colleague's tap and a pushed commit.

  it("vault_write is approval-gated on EVERY call, including one already approved once", async () => {
    expect(vaultWrite.approval, "vault_write must be gated — it commits and pushes").toBeTypeOf("function");
    const decision = await vaultWrite.approval!({
      approvedTools: new Set(["vault_write"]), // already approved once — must still prompt
      callId: "call_1",
      toolName: "vault_write",
      toolInput: {},
      ...ctx(slackAuth(BENDIK)),
    } as never);
    expect(decision).toBe("user-approval");
  });

  it("studio_ideate is NOT gated — but still re-checks the approver", () => {
    // Bendik's call, 2026-08-24, after seeing the first live card: a gate in front of a run he
    // had just asked for carried no decision content, and it devalued the vault_write gate
    // beside it. The approver re-check STAYS, and that distinction is the point of this test —
    // "ungated" here means "no card", not "no identity check". The refusal itself is proven by
    // the two cases below.
    expect(
      studioIdeate.approval,
      "re-gating the studio is a decision, not a refactor — see tests/agent-declaration.test.ts",
    ).toBeUndefined();
  });

  it("vault_write refuses a non-allowlisted approver, and writes NOTHING", async () => {
    const before = git(atlasRoot, "rev-parse", "HEAD").trim();
    await expect(
      vaultWrite.execute(
        { area: "shared", title: "Not mine to approve", body: "…" },
        ctx(slackAuth(SOMEONE_ELSE)),
      ),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(existsSync(join(atlasRoot, "_inbox"))).toBe(false);
    expect(git(atlasRoot, "rev-parse", "HEAD").trim()).toBe(before);
  });

  it("vault_write refuses a fully unauthenticated session", async () => {
    await expect(vaultWrite.execute({ area: "shared", title: "x", body: "…" }, ctx(null))).rejects.toThrow(
      UnauthorizedApproverError,
    );
  });

  it("studio_ideate refuses BEFORE spending anything", async () => {
    // The refusal is the first line of `execute`, ahead of the ten paid model calls and ahead
    // of the Atlas read. Proven by the absence of a gateway credential in this environment:
    // if the pipeline were reached at all, the failure would be a gateway error, not this one.
    //
    // This matters MORE since the gate came off, not less: with no approval card, this check is
    // now the only thing standing between a non-Slack route and ten paid model calls.
    await expect(studioIdeate.execute({ brief: "not mine to approve" }, ctx(slackAuth(SOMEONE_ELSE)))).rejects.toThrow(
      UnauthorizedApproverError,
    );
    await expect(studioIdeate.execute({ brief: "x" }, ctx(null))).rejects.toThrow(UnauthorizedApproverError);
  });
});

describe("vault_write, when the owner approves", () => {
  it("commits and pushes into _inbox, with the old hand's normalised frontmatter", async () => {
    const result = (await vaultWrite.execute(
      { area: "shared", title: "Zero7 launch angles", body: "Three angles worth trying.", tags: ["ideation"] },
      ctx(slackAuth(BENDIK)),
    )) as { commit: string };

    expect(result.commit).toMatch(/^[0-9a-f]{7,}$/u);

    const written = git(atlasRoot, "show", "HEAD:_inbox/zero7-launch-angles.md");
    expect(written).toContain("title: Zero7 launch angles");
    expect(written).toContain("tags: [ideation]");
    expect(written).toContain("Three angles worth trying.");

    // NORMALISED, not passed through — parity with agent-runtime/lib/adapters/hands/atlas.ts:39.
    // The model supplies a title, a body and optional tags and nothing else reaches the file,
    // so the Atlas stays queryable by `type` instead of carrying whatever keys a model invented.
    expect(written).toContain("type: note");

    // Provenance, stamped from the agent name by the old hand for the same reason: without it
    // every note she has ever saved is indistinguishable from one Bendik wrote by hand.
    expect(written).toContain("source: calliope");
    expect(written).toContain("owner: calliope");

    // Attribution in the vault's git log — the only audit trail an Atlas write has. The kit's
    // default message says "note(saga)", which would credit a different agent.
    expect(git(atlasRoot, "log", "-1", "--pretty=%s").trim()).toBe("note(calliope): _inbox/zero7-launch-angles.md");

    // It reached the BARE remote, not just the working clone — an Atlas that looks updated
    // locally while the bare never got it is the ORB-51 silent-failure shape.
    expect(git(bareDir, "show", "HEAD:_inbox/zero7-launch-angles.md")).toBe(written);
  });

  it("defaults tags to an empty list rather than omitting the key", async () => {
    await vaultWrite.execute({ area: "shared", title: "No tags here", body: "x" }, ctx(slackAuth(BENDIK)));
    expect(git(atlasRoot, "show", "HEAD:_inbox/no-tags-here.md")).toContain("tags: []");
  });

  it("stamps provenance the model cannot override", async () => {
    // The model has no `frontmatter` input at all any more, so `source`/`owner` are not merely
    // spread last — they are unreachable. The nearest thing it can still try is smuggling a
    // claim through the body, which must not end up in the frontmatter block.
    await vaultWrite.execute(
      { area: "shared", title: "Claims", body: "---\nsource: bendik\nowner: bendik\n---\n\nnot frontmatter" },
      ctx(slackAuth(BENDIK)),
    );
    const written = git(atlasRoot, "show", "HEAD:_inbox/claims.md");
    const frontmatter = written.split("---")[1]!;
    expect(frontmatter).toContain("source: calliope");
    expect(frontmatter).not.toContain("source: bendik");
  });

  it("makes traversal UNREPRESENTABLE — the path is derived, never supplied", async () => {
    // The controller's fix-round-1 ruling, asserted as a property rather than as a refusal.
    // There is no `path` input to refuse: a path-shaped title is flattened into a filename
    // inside _inbox. This covers the case containment alone would have allowed — `.git/config`
    // is IN the store, so `resolveInStore` would have passed it and the file would have been
    // clobbered on disk before `git add --` ever rejected it.
    const gitConfigBefore = readFileSync(join(atlasRoot, ".git", "config"), "utf8");

    for (const [title, expected] of [
      ["../../etc/passwd", "_inbox/etc-passwd.md"],
      [".git/config", "_inbox/git-config.md"],
      ["/ventures/zero7", "_inbox/ventures-zero7.md"],
    ] as const) {
      await vaultWrite.execute({ area: "shared", title, body: "x" }, ctx(slackAuth(BENDIK)));
      expect(existsSync(join(atlasRoot, expected)), `${title} → ${expected}`).toBe(true);
    }

    // Nothing outside _inbox moved: the seed note is untouched, git's own config is untouched,
    // and the only directory added at the store root is _inbox.
    expect(readFileSync(join(atlasRoot, ".git", "config"), "utf8")).toBe(gitConfigBefore);
    expect(git(atlasRoot, "show", "HEAD:ventures/zero7.md")).toContain("Norwegian mid-market");
    expect(readdirSync(atlasRoot).filter((e) => !e.startsWith(".")).sort()).toEqual(["_inbox", "ventures"]);

    // And the schema itself refuses to carry one: `path` is not an accepted input. `area` is
    // (W5C-s4) — it says WHICH store, never where inside it.
    expect(Object.keys((vaultWrite.inputSchema as { shape: Record<string, unknown> }).shape).sort()).toEqual([
      "area",
      "body",
      "tags",
      "title",
    ]);
  });

  it("NEVER WIDENS: the one write tool refuses the private area, against the real declaration", async () => {
    // W5C-s4. `atlas_write` was bound to the shared store at construction, so the filename was
    // the permission. The area is an input now — this is what replaces that binding, and it is
    // checked against the committed declaration (`agent.json` grants `atlas` and nothing else),
    // not against a fixture. The approver is allowlisted, so the refusal below can only be the
    // area guard.
    const before = git(atlasRoot, "rev-parse", "HEAD").trim();
    await expect(
      vaultWrite.execute({ area: "private", title: "Not her store", body: "…" }, ctx(slackAuth(BENDIK))),
    ).rejects.toThrow(/"private" area of the Vault was not granted/);
    expect(git(atlasRoot, "rev-parse", "HEAD").trim()).toBe(before);
  });
});

describe("she has NO Brain access — Atlas only", () => {
  /**
   * A source grep, deliberately, and the one place it is the right instrument: this asserts
   * that no file ANYWHERE in the service names the Brain, including a file nothing imports yet.
   * An object-level check can only see the tools that are wired up today.
   *
   * The physical half of the same rule lives in compose (Task 7): no VAULT_PATH, no /srv/brain
   * volume. The declaration half lives in agent.json: no `brain` grant, which is what turns the
   * ten agent-kit Brain/vault tools into disable sentinels. This is the code half.
   */
  const SERVICE_ROOT = join(import.meta.dirname, "..");
  // W5C-s3 note: `lib/vault-areas.ts` is what enforces this at run time now. The grep below
  // still holds — nothing in this service names the personal store or its setting — and the
  // test above proves the declaration-driven half.
  const SKIP_DIRS = new Set(["node_modules", ".output", ".eve", ".git", "dist"]);

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) out.push(...sourceFiles(abs));
      else if (entry.endsWith(".ts")) out.push(abs);
    }
    return out;
  }

  it("names storeRoot(\"brain\") and VAULT_PATH nowhere outside this test file", () => {
    const files = sourceFiles(SERVICE_ROOT).filter((f) => f !== import.meta.filename);
    // Sanity: a walk that found nothing would make the rest vacuously true.
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Comments are allowed to DISCUSS the Brain — extension.ts's whole docblock is about why
      // she has none — so the check is for the code shapes that would actually reach it.
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/u.test(l))
        .join("\n");
      expect(code, `${file} must not resolve the Brain store`).not.toContain('storeRoot("brain")');
      expect(code, `${file} must not read VAULT_PATH`).not.toContain("VAULT_PATH");
    }
  });
});

// W7A-s6 — vault_write now also checks WHICH card it was shown (`assertApproval`,
// `lib/approvals.ts`), not only who tapped it. These cases pin the ORDER inside `execute`: the
// approver check (already proven above, on the real allowlist) runs first and unconditionally;
// the card check runs after it and before any git write. Mocking the same technique
// tests/memory-reads-tools.test.ts documents: a dynamic `await import(...)` AFTER
// `vi.resetModules()`, undone in `afterEach` — a static top-level import binds to a different
// module instance than the mock.
describe("vault_write checks which card it answered, after the approver and before any write", () => {
  // Whoever `beforeEach` above put on the allowlist — read back rather than named again, so
  // this describe's own text carries no fixture identity beyond what the file already set up.
  const allowedApprover = () => process.env["SLACK_ALLOWED_USER_IDS"]!;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@lares/agent-kit/approval-ledger");
    vi.restoreAllMocks();
  });

  it("the approver check still runs first — an unauthorised approver refuses before the card check is ever reached", async () => {
    const asked = vi.fn();
    vi.doMock("@lares/agent-kit/approval-ledger", () => ({
      assertApprovedCall: async (_ledger: unknown, call: unknown) => { asked(call); },
      approvalLedger: () => ({}),
      callIdFrom: () => "call-order-1",
    }));
    const freshVaultWrite = (await import("../catalogue/vault_write.js")).default;
    // The statically-imported `UnauthorizedApproverError` at the top of this file is a
    // DIFFERENT class than the one this fresh, post-resetModules module graph throws
    // (memory-reads-tools.test.ts's own header explains why) — re-imported here so
    // `instanceof` compares the same prototype the thrown error actually has.
    const { UnauthorizedApproverError: FreshUnauthorizedApproverError } = await import("../lib/approvals.js");
    const before = git(atlasRoot, "rev-parse", "HEAD").trim();
    await expect(
      freshVaultWrite.execute({ area: "shared", title: "x", body: "…" }, ctx(slackAuth(SOMEONE_ELSE))),
    ).rejects.toThrow(FreshUnauthorizedApproverError);
    expect(asked).not.toHaveBeenCalled();
    expect(git(atlasRoot, "rev-parse", "HEAD").trim()).toBe(before);
  });

  it("a refusal from the card check happens with the approver already having passed, and before any git write", async () => {
    vi.doMock("@lares/agent-kit/approval-ledger", () => ({
      assertApprovedCall: async () => { throw new Error("stale — refused by the card check"); },
      approvalLedger: () => ({}),
      callIdFrom: () => "call-order-2",
    }));
    const freshVaultWrite = (await import("../catalogue/vault_write.js")).default;
    const before = git(atlasRoot, "rev-parse", "HEAD").trim();
    await expect(
      freshVaultWrite.execute({ area: "shared", title: "x", body: "…" }, ctx(slackAuth(allowedApprover()))),
    ).rejects.toThrow("stale — refused by the card check");
    expect(git(atlasRoot, "rev-parse", "HEAD").trim()).toBe(before);
  });

  it("when the card check passes, the write proceeds exactly as it did before this slice", async () => {
    const checked = vi.fn();
    vi.doMock("@lares/agent-kit/approval-ledger", () => ({
      assertApprovedCall: async (_ledger: unknown, call: unknown) => { checked(call); },
      approvalLedger: () => ({}),
      callIdFrom: () => "call-order-3",
    }));
    const freshVaultWrite = (await import("../catalogue/vault_write.js")).default;
    const result = (await freshVaultWrite.execute(
      { area: "shared", title: "Order check", body: "x" },
      ctx(slackAuth(allowedApprover())),
    )) as { commit: string };
    expect(checked).toHaveBeenCalledTimes(1);
    expect(result.commit).toMatch(/^[0-9a-f]{7,}$/u);
    expect(git(atlasRoot, "show", "HEAD:_inbox/order-check.md")).toContain("Order check");
  });
});
