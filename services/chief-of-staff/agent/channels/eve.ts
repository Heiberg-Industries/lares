import { assertPrivateConsoleRequest, assertVerifiedPrivateConsoleMessage, verifiedPrivateConsoleMessageReceipt,
  verifiedPrivateConsoleModelMessageReceipt, verifiedPrivateConsoleModelResponseReceipt,
  PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER } from "@lares/agent-kit/private-console-envelope";
import type { UserContent } from "ai";
import { consoleRouteAdmission, consoleAdmission } from "@lares/agent-kit/console-turn-authority";
import { vaultBrokerRequest } from "@lares/agent-kit/vault-broker-client";
import { modelPurposeRequest } from "@lares/agent-kit/model-purpose-client";
import { readFileSync } from "node:fs";
import { eveChannel } from "eve/channels/eve";
import {
  localDev,
  verifyHttpBasic,
  withAuthChallenges,
  type AuthFn,
} from "eve/channels/auth";

import { CONSOLE_AUTHENTICATOR, consoleMember } from "../../lib/principals.js";

// Route auth (INBOUND): who may reach this agent's HTTP session routes.
// GET /eve/v1/health is always public and never walks this policy.
//
// Self-hosted, no Vercel deployment: vercelOidc is omitted per eve's own auth docs
// ("omit vercelOidc unless you specifically want to accept Vercel-issued tokens").
// This replaces the scaffold's placeholderAuth, which rejects everything in production
// and which the scaffold itself flags as replace-before-reachable.

/** The role-neutral username every installation may use. */
export const ROUTE_USERNAME = "eve";
/** Usernames this role accepts. One, the same in every role. */
export const ACCEPTED_USERNAMES: readonly string[] = [ROUTE_USERNAME];

const DEFAULT_PASSWORD_FILE = "/run/secrets/eve-route-password";

/** The secret-file path, neutral variable first. Exported for the test only. */
export function routePasswordPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env["EVE_ROUTE_PASSWORD_FILE"] ??
    DEFAULT_PASSWORD_FILE
  );
}

// Read on first REQUEST, never at import — the same rule (and the same trap) as the gateway
// key in lib/gateway-provider.ts. `eve build` evaluates this module to compile the agent, and
// a build has no secrets and must not need any; reading here at module scope would fail the
// image build outright. This is also why the password cannot be handed to eve's `httpBasic`
// helper, which takes its credentials as a plain value at construction: we call the same
// verifier it uses, `verifyHttpBasic`, at request time instead. That keeps eve's constant-time
// comparison — the password is never compared by hand.
let cachedPassword: string | undefined;

function routePassword(): string {
  if (cachedPassword !== undefined) return cachedPassword;
  const path = routePasswordPath();
  try {
    cachedPassword = readFileSync(path, "utf8").trim();
  } catch {
    // Path only — never the file contents — matching the gateway provider's error shape.
    throw new Error(`secret file not readable: ${path}`);
  }
  if (cachedPassword.length === 0) {
    // An empty password would otherwise authenticate anyone who sends an empty one.
    throw new Error(`secret file is empty: ${path}`);
  }
  return cachedPassword;
}

/**
 * The header the console's chat proxy sets to name the signed-in member it is acting for
 * (`MEMBER_HEADER` in `services/console/lib/chat-proxy.ts`). The console STRIPS whatever
 * the browser sent under this name — its forwarded-header list is deny-by-default — and sets its
 * own from the session cookie it has just verified.
 *
 * READ ONLY AFTER THE ROUTE PASSWORD HAS BEEN VERIFIED. That is the whole trust boundary, and it
 * is worth writing out rather than leaving to be inferred: this agent believes the header because
 * the request already proved it knows the agent's own route password, so **anyone holding that
 * password can claim to be any member**. Today that is the console container and the keeper, both
 * on the owner's own server (the same sentence is in
 * `docs/decisions/0022-the-tested-install-path.md`). The claim is still only a claim:
 * `lib/principals.ts` checks the named member against this agent's own allow-list before it may
 * approve anything, and an unset list admits nobody.
 */
export const MEMBER_HEADER = "x-lares-member";
const MODEL_PURPOSE_REQUIRED_HEADER = "x-lares-model-purpose-required";

/** eve's own `SessionAuthContext`, named without a second import path: it is exactly what an
 *  `AuthFn` may return. */
type DoorSessionAuth = NonNullable<Awaited<ReturnType<AuthFn<Request>>>>;

/**
 * eve's own session auth with the console's member stamped on it — or eve's own, untouched, when
 * no usable member was asserted.
 *
 * `verifyHttpBasic` returns `{attributes: {}, authenticator: "http-basic", principalId: <username>,
 * principalType: "user"}` (bundled dist, eve 0.60.1, `dist/src/channel/auth/http-basic.js`'s
 * `authenticateHttpBasicStrategy` → `createRuntimeSessionAuthContext`), which says only "this
 * caller knows the route password". That is deliberately NOT a channel in `lib/principals.ts`, so
 * an operator with the password can start a session and still approve nothing. Only the
 * `lares-console` stamp below is a channel, and only `attributes.user_id` — the same key eve's own
 * Slack and Telegram channels use — says who.
 *
 * A malformed or absent header is NOT an error: it leaves the plain `http-basic` context in place,
 * which fails closed at the approval gate. `consoleMember` is the shape check, and it runs before
 * any allow-list is consulted.
 */
function withConsoleMember(sessionAuth: DoorSessionAuth, supplied: string | null): DoorSessionAuth {
  const member = consoleMember(supplied);
  if (member === null) return sessionAuth;
  return {
    ...sessionAuth,
    attributes: { ...sessionAuth.attributes, user_id: member },
    authenticator: CONSOLE_AUTHENTICATOR,
    principalId: member,
    principalType: "user",
  };
}

async function admitModelPurpose(receipt: ReturnType<typeof verifiedPrivateConsoleModelMessageReceipt> |
  ReturnType<typeof verifiedPrivateConsoleModelResponseReceipt>): Promise<string> {
  const result = await modelPurposeRequest<{ pendingReceipt?: unknown }>('request.admit', {
    capsule: receipt.modelCapsule,
    receipt,
  });
  if (typeof result.pendingReceipt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.pendingReceipt)) {
    throw new Error('Model purpose authority is not available');
  }
  return result.pendingReceipt;
}

/** HTTP Basic against the box secret. Returns null (skip, → 401) on a missing or wrong
 *  credential; never throws for a bad credential, so the walk stays a walk. Tries every
 *  accepted username with eve's own constant-time comparison — never a comparison by hand.
 *
 *  `trustedForwarders` is deliberately NOT configured on the channel below, and that is what keeps
 *  the header the ONLY way a member can be asserted: eve answers 403 to a `forwardedPrincipal`
 *  field in a request BODY whenever a channel declares no forwarder predicate
 *  (`dist/src/channel/forwarded-principal.js`'s `resolveForwardedPrincipal`). So a browser cannot
 *  smuggle an identity through the body the console passes along, and the console does not have to
 *  parse that body to stop it. */
export const basicFromSecretFile: AuthFn<Request> = async (request) => {
  const password = routePassword();
  for (const username of ACCEPTED_USERNAMES) {
    const result = verifyHttpBasic(request.headers.get("authorization"), {
      username,
      password,
    });
    if (result.ok) {
      const legacy = withConsoleMember(result.sessionAuth, request.headers.get(MEMBER_HEADER));
      try {
        if (request.headers.has("x-lares-member-id") || request.headers.has("x-lares-admission") || request.headers.has("x-lares-purpose")) await assertPrivateConsoleRequest(request);
        const attributes = await consoleRouteAdmission(request);
        if (!attributes) return legacy;
        const modelRequiredHeader = request.headers.get(MODEL_PURPOSE_REQUIRED_HEADER);
        if (modelRequiredHeader !== null && modelRequiredHeader !== '1') return null;
        const modelRequired = modelRequiredHeader === '1';
        const hasModelCapsule = request.headers.has(PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER);
        if (modelRequired && !hasModelCapsule) return null;
        if (hasModelCapsule && attributes.lares_purpose === 'human') {
          // Validate the exact raw human envelope now; onMessage performs admission with
          // the parsed message matched against this same Request's WeakMap receipt.
          const body = await request.clone().json() as { message?: unknown };
          verifiedPrivateConsoleModelMessageReceipt(request, body.message);
        }
        let modelPending: string | undefined;
        // Approval responses skip onMessage. Admit them here, only after the raw Request has
        // passed its exact-envelope check and the current resolver was authenticated above.
        if (attributes.lares_purpose === 'resolver' && request.headers.has(PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER)) {
          modelPending = await admitModelPurpose(verifiedPrivateConsoleModelResponseReceipt(request));
        }
        return { ...legacy, authenticator: CONSOLE_AUTHENTICATOR,
          ...(attributes.lares_member_id ? {principalId:attributes.lares_member_id,principalType:'user' as const}:{}),
          attributes: { ...legacy.attributes, ...attributes,
            ...(modelRequired ? { lares_model_purpose_required: '1' } : {}),
            ...(modelPending ? { lares_model_pending_receipt: modelPending } : {}) } };
      } catch { return null; }
    }
  }
  return null;
};

export async function onPrivateConsoleMessage(ctx: { eve: { caller?: DoorSessionAuth | null; request: Request } }, message: string | UserContent) {
    const caller = ctx.eve.caller;
    const tagged = caller?.attributes?.lares_member_id !== undefined;
    if (tagged && typeof message !== "string") throw new Error("Private console messages must be plain text");
    if (tagged) assertVerifiedPrivateConsoleMessage(ctx.eve.request, message);
    if (tagged && consoleAdmission(caller)?.purpose !== "human") throw new Error("Conversation authority is not available");
    if(tagged){
      let modelPending:string|undefined;
      if (ctx.eve.request.headers.has(PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER)) {
        modelPending = await admitModelPurpose(verifiedPrivateConsoleModelMessageReceipt(ctx.eve.request,message));
      }
      let vaultPending:string|undefined;
      try{const receipt=verifiedPrivateConsoleMessageReceipt(ctx.eve.request,message);const result=await vaultBrokerRequest<{pendingReceipt?:unknown}>('request.admit',{capsule:receipt.vaultCapsule,receipt});if(typeof result.pendingReceipt==='string'&&/^[A-Za-z0-9_-]{43}$/.test(result.pendingReceipt))vaultPending=result.pendingReceipt;}catch{/* Broker absence disables only Vault reads. */}
      const attributes={...caller?.attributes,...(modelPending?{lares_model_pending_receipt:modelPending}:{}),...(vaultPending?{lares_vault_pending:vaultPending}:{})};
      return {auth:modelPending||vaultPending?{...caller,attributes}:caller};
    }
    return { auth: caller ?? null };
}

export default eveChannel({
  onMessage: onPrivateConsoleMessage,
  auth: [
    // Open on localhost for `eve dev` and the REPL; inert under `eve start`.
    localDev(),
    // `withAuthChallenges` makes a rejection advertise `Basic`, so a caller is told HOW to
    // authenticate instead of just being refused.
    withAuthChallenges(basicFromSecretFile, [
      { scheme: "Basic", parameters: { realm: "lares" } },
    ]),
  ],
});
