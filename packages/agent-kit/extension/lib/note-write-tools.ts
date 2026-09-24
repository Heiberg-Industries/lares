/**
 * THE VAULT'S THREE WRITE TOOLS, AS FACTORIES (W5C-s4) — `vault_write`, `vault_file`,
 * `vault_drop` — the three tools the personal store used to name after itself.
 *
 * W5C-s3 did this for the four READ tools: they stopped binding a store at construction and
 * took the area as an input plus an injected "which areas may this session open?" authority.
 * These three follow, and the bar is higher because they change the owner's notes.
 *
 * WHY THE FACTORIES LIVE HERE AND NOT IN `src/note-tools.ts`. The approver re-check
 * (`assertApprover`) resolves through `../lib/approval-gate.ts`, which reads THIS extension's
 * own bound config (`extension.config.brain?.isApprovedPrincipal`). eve binds that config to
 * the module instance its loader mounted — `dist/extension/extension.mjs`. A copy of these
 * factories under `src/`, imported by a service as raw TypeScript, would construct a SECOND
 * `defineExtension` instance with no scope, whose `config.brain` is always `undefined`, and
 * `makeApprovalGate` treats that as "no principal is approved": every vault write would refuse,
 * for ever, with no build or type error to say so. So the factories stay inside the extension
 * and are reached through the `@lares/agent-kit/note-write-tools` export, which — like
 * `@lares/agent-kit/tools` — points at `dist/`, the same module graph eve mounted.
 *
 * NEVER WIDEN, AND IN TWO PLACES AT ONCE:
 *
 *   (a) `KIT_WRITE_AREAS` — these tools have only ever written the PERSONAL store
 *       (`storeRoot("brain")`), so that is the only area they serve. This is not redundant with
 *       (b): chief-of-staff's declaration grants `brain` AND `atlas`, so `grantedVaultAreas`
 *       returns the shared area too, and without this constant the rename would hand it a
 *       shared-store write it does not have today. Reads could be folded symmetrically because
 *       chief-of-staff already had both `vault_read` and `atlas_read`; writes cannot, because
 *       it never had an `atlas_write`. That asymmetry is the whole reason this constant exists.
 *
 *   (b) the injected `areas` authority — the SAME one W5C-s3 introduced, read per session from
 *       the same definition the tool list resolved from (`services/<role>/lib/vault-areas.ts`).
 *       Omitted ⇒ NO area is open: the mounted `extension/tools/vault_*.ts` copies have no
 *       authority and every role service supersedes them.
 *
 * The two are intersected, so the answer is never wider than either. A revoked grant closes the
 * door mid-session; the constant keeps it shut even when the grant is wide.
 *
 * ORDER OF GUARDS IS UNCHANGED. `assertApprover` runs FIRST, exactly as it did in the three
 * `brain_*.ts` files, before any area is resolved and before any store root is read — so a call
 * from a principal who may not approve is refused for that reason, not for an area one. Every
 * other guard on the write path (`origin-taint`'s `stampFor`/`turnKeyFrom` on the new note, the
 * git containment inside `commitNote`/`moveNote`/`removeNote`) is carried across verbatim.
 *
 * W7A-s2 — THE APPROVAL IS INJECTABLE NOW, AND THAT IS THE POINT. These three hard-coded eve's
 * `always()`, so the permissions board was never consulted for them: a 🚫 on "Private notes" did
 * not refuse a note write, and none of the three ever wrote an `approval_events` row, leaving the
 * console's evidence column for that row permanently blank. A mounting service now passes its own
 * `approvalFor("<the tool's own name>")` — the same policy every other gated tool of that role
 * carries — and `boardApproval` keys it on `(agent, "vault", "private")`, the row the console
 * already renders as "Private notes".
 *
 * NOTHING BECAME EASIER. Omitting `approval` still means `always()` (the mounted
 * `../tools/vault_*.ts` copies have no board to reach), and on a box with no `ratchet` row the
 * board falls back to the definition's own `vault: "gated"` — the same card as before. What
 * changed is that the dial now works in both directions, and that `agent-kit__vault_drop` keeps
 * asking even at ✓, because deleting is an always-ask `delete` category (owner decision A1).
 *
 * W7A-s6 — THE CARD IS CHECKED TOO, NOT ONLY THE APPROVER, AND THE CHECK COMES IN THROUGH
 * `NoteWriteDeps` RATHER THAN THROUGH `./approval-gate.ts`. Every OTHER gated tool in this wave
 * grew one shared `assertApproval(ctx, toolName, input)` beside its own copy of the approver
 * re-check (`services/chief-of-staff/lib/approvals.ts`, `services/creative/lib/approvals.ts`),
 * wrapping `assertApprover` and the new `assertApprovedCall`
 * (`@lares/agent-kit/approval-ledger`, W7A-s5) in one place. `./approval-gate.ts` — this
 * extension's own copy — deliberately does NOT: `assertApprovedCall`/`approvalLedger` live in
 * `../../src/approval-ledger.ts`, and `../../src/db.ts` underneath it, and that module is
 * reached by every OTHER consumer as `@lares/agent-kit/approval-ledger` → plain TypeScript, one
 * module instance, `getPool()` called lazily inside a function body. Importing it from THIS
 * file (or from `./approval-gate.ts`) would instead pull it through `eve extension build`'s
 * bundler into `dist/extension/lib/note-write-tools.mjs` — a SECOND module instance (its own
 * `warnedAboutApprovalAsks` flag, unable to agree with the first about anything) bundled into
 * code the build step itself loads with no `DATABASE_URL` and no live Postgres, exactly the
 * thing `getPool()`'s own laziness exists to keep out of `eve build` (see `../../src/db.ts`'s
 * header) — and the one thing this factory has never done (see "NO CREDENTIAL OR PATH READ AT
 * MODULE SCOPE" above; `storeRootForArea` is deferred for the identical reason). So the check
 * for these three tools is INJECTED instead, exactly like `approval` above: the mounting
 * service — which already imports `@lares/agent-kit/approval-ledger` directly for its other
 * gated tools — passes `assertApprovedCall` bound to its own `approvalLedger()`/`callIdFrom`,
 * and `execute` calls it right after the approver check and before any area is resolved.
 * Omitted ⇒ no check, exactly like an omitted `approval`: the mounted `../tools/vault_*.ts`
 * copies have no ledger to reach either.
 */
import { basename } from "node:path";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

// Relative imports, not the package specifier: eve's extension bundler refuses a
// self-referencing package import from within this package's own extension source
// (verified by running `eve extension build` — see ../tools/vault_search.ts's header).
import { commitNote, moveNote, removeNote } from "../../src/vault-git.js";
import { storeRootForArea } from "../../src/notes-store.js";
import { DESCRIBE_AREA, NOTE_AREAS, type NoteToolDeps } from "../../src/note-tools.js";
import { ORIGIN_FRONTMATTER_KEY } from "../../src/origin.js";
import { stampFor, turnKeyFrom } from "../../src/origin-taint.js";
import type { VaultArea } from "../../src/skill-grants.js";
import { approverFrom, assertApprover } from "./approval-gate.js";

/**
 * A request-time approval policy the MOUNTING SERVICE supplies — in practice
 * `approvalFor("<tool name>")` from `services/<role>/lib/board.ts`, which is `boardApproval`
 * bound to that role's declaration.
 *
 * STRUCTURALLY TYPED ON PURPOSE, and the kit cannot name eve's own `Approval<T>` here: it is
 * invariant in the tool's input type and rejects a concretely-typed tool — the same reason
 * `CatalogueEntry.tool` is structural in `@lares/agent-kit/manifest`, and the reason each
 * catalogue entry is cast `as never` in `services/<role>/agent/tools/catalogue.ts`.
 *
 * ADAPTED FROM THE SLICE'S `(ctx?: unknown) => unknown`, which does not compile under this
 * package's `strict` (and therefore `strictFunctionTypes`): a policy declaring a concrete
 * context parameter — `approvalFor`'s `(ctx?: ApprovalCallContext) => Promise<ApprovalStatus>` —
 * is not assignable to one declaring `unknown`, because the check on parameters runs the other
 * way round. `never[]` accepts every such policy and still forbids a non-function.
 *
 * IT STAYS A FUNCTION, DELIBERATELY. eve 0.60.1 also accepts `approval: { request, response }`,
 * and adopting that object here would break two things at once: every Telegram approval (eve
 * resumes a tap with `auth: null`, which its response-policy path answers with
 * UNAUTHENTICATED_APPROVAL_FEEDBACK), and every role's durable descriptor — the resolver in
 * `services/<role>/agent/tools/catalogue.ts` re-stamps the policy by CALLING `tool.approval`,
 * and an object called as a function fails the descriptor, which eve punishes by dropping the
 * WHOLE resolver result (the 4/2/3-tools incident). Recorded so nobody "modernises" it.
 */
export type NoteWriteApproval = (...args: never[]) => unknown;

/**
 * The card-freshness/payload check a MOUNTING SERVICE supplies (W7A-s6) — in practice a closure
 * over `assertApprovedCall(approvalLedger(), { callId: callIdFrom(ctx), toolName: "<its own
 * name>", input })` from `@lares/agent-kit/approval-ledger`, which the service already imports
 * directly (never through this extension). See this file's header for why the extension cannot
 * make this call itself. `input` is passed through UNCHANGED — never a destructured-and-rebuilt
 * object — because `payloadFingerprint` treats a key present with an `undefined` value as a
 * different call from one where the key is absent (`approval-ledger.ts`'s own canonicalisation).
 */
export type NoteWriteApprovedCallCheck = (ctx: unknown, input: unknown) => Promise<void>;

/**
 * `NoteToolDeps` plus the policy. Everything else about these three is unchanged.
 *
 * AN INTERSECTION, NOT `interface … extends …`, and that is not a style choice. This file is
 * consumed by services through `@lares/agent-kit/note-write-tools` → `dist/extension/lib/
 * note-write-tools.d.ts`, whose `import … from "../../src/note-tools.js"` does not resolve inside
 * `dist/` (the extension bundler emits `_chunks/`, not a mirrored `src/`). `skipLibCheck` hides
 * that, leaving `NoteToolDeps` as `any` for every consumer — and an INTERFACE extending it
 * publishes only its own members, so `writeTool({ areas, approval })` fails the excess-property
 * check on `areas` in all three catalogue files. An intersection with `any` stays `any`, which is
 * exactly the (unchecked) treatment `areas` has had since W5C-s4. Noticed, not fixed here:
 * making the published declarations resolvable is a build change, not this slice's.
 */
export type NoteWriteDeps = NoteToolDeps & {
  /** Omitted ⇒ eve's `always()`, which is what these three tools have always carried. */
  approval?: NoteWriteApproval;
  /** Omitted ⇒ no check — what these three have always had (W7A-s6, see this file's header). */
  assertApprovedCall?: NoteWriteApprovedCallCheck;
};

/** The areas these three tools write. One, and it is the one they have always written. See this
 *  file's header, point (a), before adding to it: a second entry here is a capability widening
 *  for every agent that mounts the kit, whatever its declaration says. */
export const KIT_WRITE_AREAS = ["private"] as const satisfies readonly VaultArea[];

/** What a session may actually write: the areas it was GRANTED, narrowed to the ones these
 *  tools serve. Exported so a test can assert it against a real committed declaration rather
 *  than against a fixture. */
export function writableAreas(granted: readonly VaultArea[]): VaultArea[] {
  return KIT_WRITE_AREAS.filter((area) => granted.includes(area));
}

/** The area sentence every one of the three descriptions ends with. Only the personal area is
 *  offered, because only the personal area is writable here — saying otherwise would invite the
 *  model to propose a write that is always refused. */
const AREA_INPUT_DOC =
  `Say which area: "private" is ${DESCRIBE_AREA.private}. These tools write that area and no ` +
  `other; an area this agent was not granted is refused.`;

const areaInput = z.enum(NOTE_AREAS);

/** The store root for a write, once both guards agree. Throws — a rejected promise the model
 *  reads as this tool's failure, the same shape the read tools' area refusal has. */
async function writableRoot(
  area: VaultArea,
  deps: NoteToolDeps | undefined,
  ctx: { session?: { id?: string } | undefined },
): Promise<string> {
  if (!(KIT_WRITE_AREAS as readonly VaultArea[]).includes(area)) {
    throw new Error(`the "${area}" area of the Vault is not written by this tool`);
  }
  const granted = deps?.areas === undefined ? [] : await deps.areas(ctx);
  if (!writableAreas(granted).includes(area)) {
    throw new Error(`the "${area}" area of the Vault was not granted to this agent`);
  }
  return storeRootForArea(area);
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "note";
}

/**
 * Propose a new note for the vault. GATED WRITE — requires the owner's 👍 on every call.
 *
 * Ported from the chief-of-staff role's own `agent/tools/` write hand (ORB-143 Task 2), itself
 * ported from `services/agent-runtime/lib/adapters/hands/brain.ts`'s "write" action
 * (hands/brain.ts:32): writes into the `_inbox/<slug>.md` convention with frontmatter, then
 * commits + pushes via `@lares/agent-kit/vault-git`'s `commitNote`. The `slug()` helper is
 * ported verbatim (hands/brain.ts:17). The approval re-check is routed through this package's
 * own `approval-gate.ts` instead of importing `assertApprover`/`approverFrom` from eve-saga's
 * `lib/approvals.ts` directly — see `./approval-gate.ts`'s docblock for why.
 *
 * W3A-s6 — stamps `lares_origin` at the source (docs/specs/2026-09-18-origin-model-design.md).
 * The intended class is `agent` (the model wrote this note); `stampFor` narrows it to
 * `third_party` for a turn that has already read somebody else's words. No usable turn key is
 * the fail-closed case: the least-trusted class, and the write still goes through — a hook or
 * context problem must never cost the owner their note.
 */
export function writeTool(deps?: NoteWriteDeps) {
  return defineTool({
    description:
      "Propose a new note for the vault (requires the owner's 👍). Written into the vault's " +
      `_inbox queue with frontmatter, then committed and pushed to the vault's git history. ${AREA_INPUT_DOC}`,
    inputSchema: z.object({
      area: areaInput,
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()).optional(),
    }),
    approval: (deps?.approval ?? always()) as never,
    async execute(input, ctx) {
      const { area, title, body, tags } = input;
      assertApprover(approverFrom(ctx.session.auth));
      await deps?.assertApprovedCall?.(ctx, input);
      const vaultRoot = await writableRoot(area, deps, ctx);

      const key = turnKeyFrom(ctx);
      const origin = key ? stampFor("agent", key) : "third_party";

      const path = `_inbox/${slug(title)}.md`;
      return commitNote({
        vaultRoot,
        path,
        frontmatter: {
          title,
          type: "note",
          source: "agent",
          [ORIGIN_FRONTMATTER_KEY]: origin,
          created: null,
          tags: tags ?? [],
        },
        body,
      });
    },
  });
}

/**
 * Move an existing vault note into a folder, as-is. GATED WRITE — requires the owner's 👍 on
 * every call.
 *
 * Ported from the chief-of-staff role's own `agent/tools/` file hand (ORB-143 Task 2), itself
 * ported from `services/agent-runtime/lib/adapters/hands/brain.ts`'s "file" action
 * (hands/brain.ts:41): moves `path` to `<destination>/<basename(path)>` via `git mv`
 * (`@lares/agent-kit/vault-git`'s `moveNote`), preserving the note's bytes and git history.
 */
export function fileTool(deps?: NoteWriteDeps) {
  return defineTool({
    description:
      "Move an existing vault note into a folder as-is, e.g. an _inbox item → writing-seeds " +
      "(requires the owner's 👍). `path` is the note's current store-relative path; " +
      `\`destination\` is the target folder. ${AREA_INPUT_DOC}`,
    inputSchema: z.object({ area: areaInput, path: z.string(), destination: z.string() }),
    approval: (deps?.approval ?? always()) as never,
    async execute(input, ctx) {
      const { area, path, destination } = input;
      assertApprover(approverFrom(ctx.session.auth));
      await deps?.assertApprovedCall?.(ctx, input);
      const vaultRoot = await writableRoot(area, deps, ctx);

      const dest = destination.replace(/\/+$/, "");
      const destPath = `${dest}/${basename(path)}`;
      return moveNote({
        vaultRoot,
        sourcePath: path,
        destPath,
        message: `file ${basename(path)} → ${dest}`,
      });
    },
  });
}

/**
 * Delete a vault note. GATED WRITE — requires the owner's 👍 on every call.
 *
 * Ported from the chief-of-staff role's own `agent/tools/` drop hand (ORB-143 Task 2), itself
 * ported from `services/agent-runtime/lib/adapters/hands/brain.ts`'s "drop" action
 * (hands/brain.ts:48): removes the note via `git rm` (`@lares/agent-kit/vault-git`'s
 * `removeNote`), committed + pushed so the removal is canonical and reversible via git history.
 */
export function dropTool(deps?: NoteWriteDeps) {
  return defineTool({
    description:
      "Delete a vault note, e.g. clear a processed _inbox item (requires the owner's 👍). " +
      `Reversible via git history. ${AREA_INPUT_DOC}`,
    inputSchema: z.object({ area: areaInput, path: z.string() }),
    approval: (deps?.approval ?? always()) as never,
    async execute(input, ctx) {
      const { area, path } = input;
      assertApprover(approverFrom(ctx.session.auth));
      await deps?.assertApprovedCall?.(ctx, input);
      const vaultRoot = await writableRoot(area, deps, ctx);

      return removeNote({
        vaultRoot,
        path,
        message: `drop ${basename(path)}`,
      });
    },
  });
}
