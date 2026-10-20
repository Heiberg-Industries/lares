import { readFileSync } from "node:fs";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { reshapeJsonBody, shapeAnthropicBody, stripBoundaryFromChatBody } from "./prompt-cache.js";

/**
 * Every eve agent's model calls go through the LiteLLM gateway — no default provider (no
 * Vercel AI Gateway, no direct provider keys) — and always through the gateway's ROUTER route
 * (`/v1/messages`, Anthropic request format; never the retired `/anthropic/v1` pass-through),
 * which is what resolves the fleet's purpose aliases (`lares-brain`, …). Same
 * env/secret contract for every agent: `GATEWAY_URL` + a key read from `GATEWAY_KEY_FILE`.
 *
 * The gateway key file's *default* path is parameterized per agent on purpose:
 * each agent gets its own budget-capped, model-allowlisted key, never shared with another
 * agent's — `createGatewayProvider({ defaultKeyFile })` is how each agent supplies its own
 * default, while `GATEWAY_KEY_FILE` still overrides it at runtime for every agent alike.
 *
 * When one of those caps actually bites, the gateway answers HTTP 400 with
 * `error.type: "budget_exceeded"`. Nothing in THIS file reacts to that — the fetch seams
 * below stay a plain pass-through on purpose (see `./gateway-budget.ts`'s header for why
 * throwing here would change which failure events eve emits). Recognition and the door's
 * fixed one-sentence answer live in `./gateway-budget.ts` (`isBudgetExceeded`,
 * `GatewayBudgetExceededError`, `respondToTurnFailed`).
 */
const DEFAULT_GATEWAY_URL = "http://lares-gateway:4000";

/**
 * The header every gateway-routed call must carry (it used to be hand-duplicated across
 * multiple callers). Forcing `Accept-Encoding: identity` was load-bearing on the
 * old `/anthropic` pass-through: that route forwarded the upstream's COMPRESSED body while dropping
 * the `Content-Encoding` header, so any client that advertises compression (undici's default
 * `gzip, deflate, br, zstd`) received compressed bytes labeled as plain and died on
 * "Invalid JSON" — AFTER the call was billed. Every call now goes through the router
 * route (`/v1/messages`), where this defect does not exist — the header is
 * kept anyway (harmless there) because it documents that history. Not parameterized — it does
 * not vary per agent.
 */
export const IDENTITY_ENCODING_HEADERS = { "Accept-Encoding": "identity" } as const;

/**
 * Which wire format this agent's calls to the gateway use. "anthropic" (the default) is the
 * only lane with production history — prompt caching (`cache_control`) and thinking blocks
 * are real @ai-sdk/anthropic behaviour on it. "openai-compatible" is for a non-Anthropic
 * vendor target, where LiteLLM's Anthropic-format-in / non-Anthropic-out translation is
 * comparatively unproven.
 * NEVER add @ai-sdk/openai / @ai-sdk/google / @ai-sdk/mistral here — those bypass the
 * gateway and talk to a vendor directly.
 */
export type GatewayLane = "anthropic" | "openai-compatible";

const VALID_LANES: readonly GatewayLane[] = ["anthropic", "openai-compatible"];

function resolveLane(defaultLane: GatewayLane): GatewayLane {
  const raw = process.env["GATEWAY_LANE"];
  if (raw === undefined || raw === "") return defaultLane;
  if ((VALID_LANES as readonly string[]).includes(raw)) return raw as GatewayLane;
  throw new Error(`GATEWAY_LANE must be "anthropic" or "openai-compatible" — got ${JSON.stringify(raw)}.`);
}

export interface GatewayProviderOptions {
  /** This agent's default gateway-key file path — overridable at runtime via
   *  `GATEWAY_KEY_FILE` regardless of what's passed here. */
  readonly defaultKeyFile: string;
  /** Defaults to the shared gateway URL; overridable at runtime via `GATEWAY_URL`. */
  readonly defaultGatewayUrl?: string;
  /** Which lane this agent uses when GATEWAY_LANE is unset. Defaults to "anthropic".
   *  Overridable at runtime via GATEWAY_LANE regardless of what's passed here — same
   *  override shape as defaultGatewayUrl/GATEWAY_URL. */
  readonly defaultLane?: GatewayLane;
}

export interface GatewayProvider {
  gatewayModel(modelId: string): LanguageModel;
  gatewayUrl(): string;
  gatewayKey(): string;
  /** Which lane gatewayModel() is (or will be) built on. Resolved from GATEWAY_LANE the same
   *  way gatewayUrl() resolves GATEWAY_URL — reads no secret, touches no disk, safe to call
   *  before or after gatewayModel(). Throws the same error gatewayModel() would if
   *  GATEWAY_LANE names neither lane. */
  gatewayLane(): GatewayLane;
}

/**
 * Builds one agent's gateway provider. Constructing it (this call) reads no secret and
 * touches no disk — every read is deferred to the first actual `gatewayModel()`/
 * `gatewayKey()` call. This is load-bearing, not a nicety: `eve build` evaluates
 * agent/agent.ts (which calls `gatewayModel` at module scope) to compile the agent's static
 * metadata, and a build has no gateway secret and must not need one — CI builds these
 * images with no credentials at all. This is also how eve's own documented direct-provider
 * pattern (`model: anthropic("claude-opus-4-8")`, docs/agent-config.md) survives a build:
 * AI SDK providers resolve credentials per request, never at construction. Reading the key
 * eagerly here is what broke the first real `docker build` with "Failed to evaluate
 * authored module".
 */
export function createGatewayProvider(opts: GatewayProviderOptions): GatewayProvider {
  const defaultGatewayUrl = opts.defaultGatewayUrl ?? DEFAULT_GATEWAY_URL;
  const defaultKeyFile = opts.defaultKeyFile;
  const defaultLane = opts.defaultLane ?? "anthropic";

  /** Exported for other gateway-routed callers that need the raw URL/key, not an AI SDK
   *  model — e.g. a raw fetch against /v1/embeddings. */
  function gatewayUrl(): string {
    return process.env["GATEWAY_URL"] ?? defaultGatewayUrl;
  }

  /** Exported alongside gatewayUrl()/gatewayKey() — same GATEWAY_LANE-overrides-default shape. */
  function gatewayLane(): GatewayLane {
    return resolveLane(defaultLane);
  }

  // Read once per process, on the first REQUEST rather than at import — sync because gatewayModel()
  // itself must stay synchronous (defineAgent({ model: gatewayModel(...) }) has no await
  // point). See the module-scope-no-secret-read note on createGatewayProvider above.
  let cachedKey: string | undefined;

  /** Exported alongside gatewayUrl() — same secret, same read-once-per-process caching. */
  function gatewayKey(): string {
    if (cachedKey !== undefined) return cachedKey;
    const path = process.env["GATEWAY_KEY_FILE"] ?? defaultKeyFile;
    try {
      cachedKey = readFileSync(path, "utf8").trim();
    } catch {
      // Path only — never the file contents — matching secrets.ts's error shape.
      throw new Error(`secret file not readable: ${path}`);
    }
    return cachedKey;
  }

  // Built once per instance and cached. Construction itself is credential-free (see above);
  // the provider picks the key up at request time by a route that suits how the SDK reads it.
  let anthropicProvider: ReturnType<typeof createAnthropic> | undefined;

  /** @ai-sdk/anthropic reads `options.apiKey` inside its per-request `getHeaders()`, so a
   *  getter defers the file read to the request — except for the one construction-time read
   *  in its `apiKey`/`authToken` conflict check. That single read must not throw (it happens
   *  during `eve build`), so it answers undefined until construction completes; every read
   *  afterwards is a real request and is strict. */
  function anthropicKeyHolder(): {
    readonly apiKey: string | undefined;
    markConstructed(): void;
  } {
    let constructed = false;
    return {
      get apiKey(): string | undefined {
        if (!constructed) return undefined;
        return gatewayKey();
      },
      markConstructed(): void {
        constructed = true;
      },
    };
  }

  /** No Authorization header — @ai-sdk/anthropic injects its own via `apiKey` (see
   *  anthropicKeyHolder above). See IDENTITY_ENCODING_HEADERS for why this header is load-
   *  bearing history; this is what once broke every model call through the old route.
   *  Also moves the system prompt's cache breakpoint to the end of the session-stable part
   *  (`./prompt-cache.ts`); a body without the boundary marker passes through untouched. */
  const identityEncodingFetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Accept-Encoding", IDENTITY_ENCODING_HEADERS["Accept-Encoding"]);
    return globalThis.fetch(input, { ...reshapeJsonBody(init, shapeAnthropicBody), headers });
  };

  /** Builds a model on the anthropic lane — always via the LiteLLM gateway, and always through
   * the gateway's ROUTER route (`/v1/messages`, Anthropic request format).: the fleet
   *  names PURPOSES (`lares-brain`, `lares-writer`, …) and the gateway maps each purpose to
   *  a model; only the router route resolves those aliases. The old `/anthropic/v1`
   *  pass-through forwarded the model name to Anthropic verbatim (an alias 404'd there) and
   *  metered spend poorly. The router translates the Anthropic request shape for non-Anthropic
   *  targets too (verified live against Mistral), which is the tested, production-history
   *  path — see buildOpenAICompatibleModel below for the newer, less-exercised alternative.
   *  Throws if the gateway key file is missing or unreadable — never falls back silently — at
   *  the moment a request is made. Constructing a model reads nothing from disk, so the image
   *  builds without credentials; the container's start command asserts the key is readable so a
   *  misconfigured secret still fails loudly at boot rather than mid-conversation. */
  function buildAnthropicModel(modelId: string): LanguageModel {
    if (anthropicProvider === undefined) {
      const holder = anthropicKeyHolder();
      // baseURL ends in /v1 — the SDK appends /messages — the gateway's router route, which
      // resolves purpose aliases and translates the Anthropic request shape for non-Anthropic
      // targets too.
      anthropicProvider = createAnthropic({
        baseURL: `${gatewayUrl()}/v1`,
        get apiKey() {
          return holder.apiKey;
        },
        fetch: identityEncodingFetch,
      });
      holder.markConstructed();
    }
    return anthropicProvider(modelId);
  }

  // ── the openai-compatible lane (GATEWAY_LANE=openai-compatible) ─────────────────────────
  // For a non-Anthropic vendor target: LiteLLM's most-exercised translation path is OpenAI
  // format in -> any vendor out, so this lane rides the better-tested road for those targets
  // (see the plan's "RULED: vendor-agnostic, and the two lanes"). The gateway is still the
  // only endpoint — this changes the WIRE FORMAT this engine speaks to it, not the vendor
  // resolution, which stays LiteLLM's job.
  let openaiCompatibleProvider: ReturnType<typeof createOpenAICompatible> | undefined;

  /** createOpenAICompatible() builds its `Authorization` header ONCE, synchronously, at
   *  construction time from `options.apiKey` (verified against the installed
   *  @ai-sdk/openai-compatible@3.0.53: `headers` is a plain object built in
   *  createOpenAICompatible's own body and `getHeaders` returns that SAME frozen object on
   *  every call — unlike @ai-sdk/anthropic, which reads `apiKey` fresh inside a per-request
   *  getHeaders() closure). Passing the anthropicKeyHolder() getter trick here would freeze
   *  Authorization OUT of that object forever, since the getter reads `undefined` before
   *  markConstructed() runs and `undefined && {...}` never adds the header. So `apiKey` (and
   *  any `headers` carrying it) is never passed to createOpenAICompatible() at all —
   *  Authorization is injected here instead, read fresh on every real request, the same
   *  place IDENTITY_ENCODING_HEADERS is already injected for the Accept-Encoding workaround.
   *  `async` on purpose (unlike identityEncodingFetch above, which never throws): gatewayKey()
   *  throws synchronously on a missing file, and fetch's own contract is to report failure as
   *  a rejected promise, not a synchronous throw — matching how the AI SDK (and this file's own
   *  live probes) actually call it. */
  const openaiCompatibleFetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Accept-Encoding", IDENTITY_ENCODING_HEADERS["Accept-Encoding"]);
    headers.set("Authorization", `Bearer ${gatewayKey()}`);
    // This lane cannot carry `cache_control`; only the boundary marker is removed (`./prompt-cache.ts`).
    return globalThis.fetch(input, { ...reshapeJsonBody(init, stripBoundaryFromChatBody), headers });
  };

  /** Builds a model on the openai-compatible lane — same gateway, same /v1 base URL, the
   *  gateway's `/chat/completions` route instead of `/v1/messages`. `name: "lares-gateway"`
   *  names this ENGINE, not a vendor — the vendor is whatever `modelId` and the gateway's own
   *  routing resolve it to. Construction reads no secret (see buildAnthropicModel's own
   *  credential-free-build note; the same `eve build` constraint applies here). */
  function buildOpenAICompatibleModel(modelId: string): LanguageModel {
    if (openaiCompatibleProvider === undefined) {
      openaiCompatibleProvider = createOpenAICompatible({
        name: "lares-gateway",
        baseURL: `${gatewayUrl()}/v1`,
        fetch: openaiCompatibleFetch,
      });
    }
    return openaiCompatibleProvider(modelId);
  }

  // ── the one entry point every agent calls — signature unchanged ─────────────────────────
  // The lane is resolved and locked in on the FIRST call and cached for the life of this
  // provider instance, matching how the URL/key are already read once and reused — GATEWAY_LANE
  // is a boot-time setting, not something that changes mid-process.
  let cachedLaneModel: ((modelId: string) => LanguageModel) | undefined;

  /** The only way this agent's code obtains a model — always via the LiteLLM gateway. Which
   *  wire format it speaks to the gateway is picked by gatewayLane() (GATEWAY_LANE, default
   *  "anthropic") — see buildAnthropicModel/buildOpenAICompatibleModel above. */
  function gatewayModel(modelId: string): LanguageModel {
    if (cachedLaneModel === undefined) {
      cachedLaneModel = gatewayLane() === "openai-compatible" ? buildOpenAICompatibleModel : buildAnthropicModel;
    }
    return cachedLaneModel(modelId);
  }

  return { gatewayModel, gatewayUrl, gatewayKey, gatewayLane };
}
