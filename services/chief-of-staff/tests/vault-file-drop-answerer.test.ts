// The Vault's three write tools check the person who ANSWERED the card, as every other gated tool does.
//
// On eve 1.0 the requester (`ctx.session.auth.current`) of a card a scheduled job raised is the app,
// and the answerer is `ctx.approval.responder`. These cases drive the REAL catalogue entries
// (`agent-kit__vault_file`, `_drop`, and `_write`'s native path) through the REAL `assertApproval`
// (`lib/approvals.ts`) and the real card check (`assertApprovedCall`), with only the ledger's rows
// and the area grant faked. The Vault is a real, disposable git repository (`VAULT_PATH`, with a bare
// remote it pushes to), so a case that passes proves the note was really moved, deleted or written
// and pushed, and a refusal proves the remote did not change. It runs the same against the built kit
// (`vitest.config.ts`) and the kit sources (`vitest.unbuilt-kit.config.ts`):
//   - the owner answers a scheduled job's card (requester: the app) → the move, delete or write runs;
//   - a second allowed person, or the app, as the answerer → refused at execution, nothing written;
//   - no card (an autonomous call the board allows) → for a move or a write, the old rule: the
//     session's caller must be an allowed approver (✓ on "Private notes" lets them act alone). A
//     delete always asks, so a delete with no answered card is refused, whoever the caller is;
//   - the card on record shows a different call → refused, whoever answered.
// No database: the ledger is a fake reader, as in `telegram-approval-card.test.ts`.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));
vi.mock("@lares/agent-kit/approval-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lares/agent-kit/approval-ledger")>()),
  approvalLedger: () => ({
    ask: async () => ledger.row,
    settle: async () => undefined,
    markUsed: async () => ({ useCount: 1 }),
  }),
}));

vi.mock("../lib/vault-areas.js", () => ({ vaultWriteAreasForTurn: async () => ["private"] }));

import { ApprovalPayloadChangedError, payloadFingerprint } from "@lares/agent-kit/approval-ledger";

import vaultDrop from "../catalogue/agent-kit__vault_drop.js";
import vaultFile from "../catalogue/agent-kit__vault_file.js";
import vaultWrite from "../catalogue/agent-kit__vault_write.js";

const telegram = (id: string) => ({ authenticator: "telegram-webhook", issuer: "telegram", principalId: id, principalType: "user", attributes: { user_id: id } });
const slack = (id: string) => ({ authenticator: "slack-webhook", issuer: "slack", principalId: id, principalType: "user", attributes: { user_id: id } });
const APP = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} };

/** A call that came back off an answered card. `requester` is who asked; `responder` who answered. */
const answered = (requester: unknown, responder: unknown) => ({
  callId: "call-1",
  session: { id: "s1", auth: { current: requester, initiator: requester } },
  approval: { responder },
});
/** A call with no card at all: an autonomous call the board allowed. */
const autonomous = (caller: unknown) => ({ callId: "call-1", session: { id: "s1", auth: { current: caller, initiator: caller } } });

type Tool = { execute: (input: unknown, ctx: unknown) => Promise<unknown> };
/** `alwaysAsks`: the board can never let it act without a card (`always-ask.ts`'s `delete`). */
type Step = "move" | "remove" | "commit";
const TOOLS: Array<{ name: string; tool: Tool; input: Record<string, unknown>; step: Step; alwaysAsks: boolean }> = [
  { name: "agent-kit__vault_file", tool: vaultFile as unknown as Tool, input: { area: "private", path: "_inbox/a.md", destination: "seeds" }, step: "move", alwaysAsks: false },
  { name: "agent-kit__vault_drop", tool: vaultDrop as unknown as Tool, input: { area: "private", path: "_inbox/a.md" }, step: "remove", alwaysAsks: true },
  { name: "agent-kit__vault_write", tool: vaultWrite as unknown as Tool, input: { area: "private", title: "t", body: "b" }, step: "commit", alwaysAsks: false },
];

/** The ledger row a card leaves: approved, fresh, and for exactly this call unless told otherwise. */
const approvedRow = (name: string, input: unknown) => ({
  requestId: "r1", callId: "call-1", agent: "chief-of-staff", tool: name,
  payloadHash: payloadFingerprint(name, input), askedAt: new Date(), answeredAt: new Date(),
  outcome: "approved", answeredVia: "telegram", usedAt: null, useCount: 0,
});

// ── A disposable Vault: a working copy holding one note, `_inbox/a.md`, and the bare remote it pushes to.
const SEED = "_inbox/a.md";
const tmpDirs: string[] = [];
let remote = "";
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
/** What the REMOTE holds: the commit count and the files at its head. */
const remoteState = () => ({
  commits: Number(git(remote, "rev-list", "--count", "HEAD").trim()),
  files: git(remote, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n").filter(Boolean).sort(),
});
let seeded: ReturnType<typeof remoteState>;

function freshVault(): void {
  const tmp = mkdtempSync(join(tmpdir(), "cos-vault-answerer-"));
  tmpDirs.push(tmp);
  remote = join(tmp, "vault.git");
  const work = join(tmp, "vault");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["clone", "--quiet", remote, work]);
  git(work, "config", "user.email", "test-suite@example.com");
  git(work, "config", "user.name", "Test Suite");
  mkdirSync(join(work, "_inbox"), { recursive: true });
  writeFileSync(join(work, SEED), "---\ntitle: a\n---\n\nseed\n", "utf8");
  git(work, "add", "--", SEED);
  git(work, "commit", "-q", "-m", "seed");
  git(work, "push", "-q", "origin", "HEAD");
  vi.stubEnv("VAULT_PATH", work);
  seeded = remoteState();
}

/** The remote gained exactly one commit, and it did what the tool says it does. */
function expectDone(step: Step): void {
  const now = remoteState();
  expect(now.commits).toBe(seeded.commits + 1);
  if (step === "move") expect(now.files).toEqual(["seeds/a.md"]);
  if (step === "remove") expect(now.files).toEqual([]);
  if (step === "commit") {
    const added = now.files.filter((f) => !seeded.files.includes(f));
    expect(now.files).toContain(SEED);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^_inbox\/.+\.md$/);
    expect(git(remote, "show", `HEAD:${added[0]}`)).toMatch(/\nb\n?$/);
  }
}
/** The remote is exactly as seeded: no commit, no file changed. */
function expectNothingDone(): void {
  expect(remoteState()).toEqual(seeded);
}

beforeEach(() => {
  vi.stubEnv("TELEGRAM_PRINCIPAL_ID", "100,200");
  vi.stubEnv("SLACK_ALLOWED_USER_IDS", "U_OWNER,U_SECOND");
  vi.stubEnv("LARES_AGENT_INCARNATION", "");
  ledger.row = null;
  freshVault();
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Vault file, drop and write check the person who answered the card", () => {
  for (const { name, tool, input, step, alwaysAsks } of TOOLS) {
    it(`${name}: the owner answers a scheduled job's card (requester: the app) → it runs`, async () => {
      ledger.row = approvedRow(name, input);
      await tool.execute(input, answered(APP, telegram("100")));
      expectDone(step);
    });

    it(`${name}: the owner answers on Slack a card a person raised → it runs`, async () => {
      ledger.row = approvedRow(name, input);
      await tool.execute(input, answered(slack("U_SECOND"), slack("U_OWNER")));
      expectDone(step);
    });

    it(`${name}: a second allowed person as the answerer → refused at execution, nothing done`, async () => {
      ledger.row = approvedRow(name, input);
      await expect(tool.execute(input, answered(APP, telegram("200")))).rejects.toThrow(/approval refused/);
      await expect(tool.execute(input, answered(telegram("100"), slack("U_SECOND")))).rejects.toThrow(/approval refused/);
      expectNothingDone();
    });

    it(`${name}: the app as the answerer, or an answerer nobody can read → refused, nothing done`, async () => {
      ledger.row = approvedRow(name, input);
      await expect(tool.execute(input, answered(telegram("100"), APP))).rejects.toThrow(/approval refused/);
      await expect(tool.execute(input, answered(telegram("100"), null))).rejects.toThrow(/approval refused/);
      expectNothingDone();
    });

    if (alwaysAsks) {
      it(`${name}: no card → refused, whoever the caller is: a delete always asks first`, async () => {
        for (const caller of [telegram("100"), telegram("200"), APP]) {
          await expect(tool.execute(input, autonomous(caller))).rejects.toThrow(/runs only from an answered card/);
        }
        expectNothingDone();
      });
    } else {
      it(`${name}: no card (autonomous) → the session's caller must be an allowed approver, as before`, async () => {
        await tool.execute(input, autonomous(telegram("200")));
        expectDone(step);
        freshVault();
        await expect(tool.execute(input, autonomous(APP))).rejects.toThrow(/approval refused/);
        await expect(tool.execute(input, autonomous(telegram("999")))).rejects.toThrow(/approval refused/);
        expectNothingDone();
      });
    }

    it(`${name}: the card on record shows a different call → refused even when the owner answered`, async () => {
      ledger.row = { ...approvedRow(name, input), payloadHash: "a-different-call" };
      await expect(tool.execute(input, answered(APP, telegram("100")))).rejects.toBeInstanceOf(ApprovalPayloadChangedError);
      expectNothingDone();
    });
  }

  // A private Console conversation is not offered a move or a delete; a call bound to one is refused
  // before any check that would read it as a door's card.
  for (const { name, tool, input } of TOOLS.filter((t) => t.name !== "agent-kit__vault_write")) {
    it(`${name}: a call bound to a private Console conversation → refused, nothing done`, async () => {
      const member = { authenticator: "basic", principalId: "m1", principalType: "user", attributes: { lares_member_id: "m1", lares_admission_nonce: "n1" } };
      await expect(tool.execute(input, answered(member, member))).rejects.toThrow(/not available in a private Console conversation/);
      expectNothingDone();
    });
  }
});
