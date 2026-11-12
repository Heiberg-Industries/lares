/**
 * Where the prompt-cache breakpoint sits in an agent's system prompt.
 *
 * In plain language: every turn re-sends the agent's whole persona to the model. The model
 * provider can bill a repeated prefix at about a tenth of the price, but only up to a marked
 * point (a "breakpoint"), and only when every byte before that point is identical to last time.
 *
 * WHAT ALREADY HAPPENS (read out of the installed eve 1.0.0-rc.10 dist,
 * `harness/model-call/request.js`, `harness/prompt-cache.js`, `harness/step-hooks.js`,
 * `definitions/definition.js`). eve marks breakpoints itself whenever the model's `provider`
 * contains "anthropic" — which `gatewayModel()` on the anthropic lane does
 * ("anthropic.messages"). It marks the last tool, the last message and the last assistant
 * message. For the system prompt it splits the instructions in two: the STATIC part (an
 * `instructions.md`, static skills, workspace files) becomes a first system message carrying
 * eve's breakpoint, and every instruction file's own section (`defineDynamic`) is joined, with
 * "\n\n", into one second system message carrying none. A role has no static part: its persona,
 * standing facts, language line and clock are all instruction files. So the first message is
 * empty and dropped, and eve sends ONE system block with NO breakpoint, the per-turn text inside
 * it. (Up to 1.0.0-rc.9 eve sent the same single block but with its breakpoint at the end, after
 * the clock; the clock moves every minute, so that breakpoint never matched across turns.)
 * Captured offline from the real role: `tests/fixtures/prompt-cache-eve-rc10-capture.json`.
 *
 * WHAT THIS MODULE DOES. Each role ends its session-scoped instructions with
 * {@link PROMPT_CACHE_BOUNDARY} (`agent/instructions/zz-cache-boundary.ts`). On the way out,
 * the gateway provider's fetch splits the system text block at that marker into two blocks and
 * puts the breakpoint on the first one: everything stable for the session is now the cached
 * prefix, and the per-turn text after it is billed normally. The marker itself never reaches the
 * model. On rc.10 the block has no breakpoint, so one is ADDED; eve's own markers are at most
 * three (last tool, last message, last assistant message), so there is always room under
 * Anthropic's limit of four. A block that already carries a breakpoint (eve up to rc.9) has it
 * MOVED instead. If a role ever gained a static part, eve's breakpoint would sit on that first
 * block, the count would reach four on every call after the first, and the session-stable part
 * would lose its breakpoint: that would need a change here.
 *
 * WHY THE FETCH AND NOT A `wrapLanguageModel` MIDDLEWARE. Both would work. The fetch is the one
 * seam every gateway request already passes (it already sets Accept-Encoding), it sees exactly
 * the bytes that go on the wire, and wrapping the model would hide `config` from the tests that
 * pin the lane's shape. No eve patch is involved.
 *
 * FAILS OPEN. A body that is not JSON, has no marker, or has an unexpected shape is sent
 * unchanged. A gateway that ignores `cache_control` still gets a valid request: two plain
 * system text blocks.
 *
 * THE OPENAI-COMPATIBLE LANE cannot carry `cache_control` at all (eve detects that lane as "no
 * caching" and marks nothing). There the marker is only removed, and the system prompt is sent
 * as one string, exactly as before.
 */

/** The line a role's last session-scoped instruction resolver emits. An HTML comment, so that
 *  if it ever did reach a model it would read as nothing. Never shown to the model by either
 *  gateway lane. */
export const PROMPT_CACHE_BOUNDARY = "<!-- lares:end-of-session-stable-prompt -->";

/** Anthropic rejects a request with more than four `cache_control` blocks. */
export const MAX_CACHE_BREAKPOINTS = 4;

const EPHEMERAL = { type: "ephemeral" } as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Splits `text` at the first boundary marker; `undefined` when there is none. */
export function splitAtBoundary(text: string): { head: string; tail: string } | undefined {
  const at = text.indexOf(PROMPT_CACHE_BOUNDARY);
  if (at === -1) return undefined;
  return {
    head: text.slice(0, at).trimEnd(),
    tail: text.slice(at + PROMPT_CACHE_BOUNDARY.length).split(PROMPT_CACHE_BOUNDARY).join("").trim(),
  };
}

/** How many blocks in an Anthropic Messages body already carry `cache_control`. */
function countBreakpoints(body: Json): number {
  let count = 0;
  const visit = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) if (isObject(block) && block["cache_control"] !== undefined) count += 1;
  };
  visit(body["tools"]);
  visit(body["system"]);
  if (Array.isArray(body["messages"])) {
    for (const message of body["messages"]) if (isObject(message)) visit(message["content"]);
  }
  return count;
}

/**
 * The anthropic lane: an Anthropic Messages request body (`/v1/messages`), reshaped so the
 * breakpoint sits at the boundary. Returns the SAME object when there is nothing to do.
 *
 * The system text block holding the marker becomes two blocks: the head (everything before the
 * marker) carries the breakpoint, the tail (everything after) carries none. If the original
 * block had a breakpoint (eve's), it moves to the head; if it had none, one is added only while
 * the body is under {@link MAX_CACHE_BREAKPOINTS}.
 */
export function shapeAnthropicBody(body: unknown): unknown {
  if (!isObject(body)) return body;
  const system = typeof body["system"] === "string" ? [{ type: "text", text: body["system"] }] : body["system"];
  if (!Array.isArray(system)) return body;

  const index = system.findIndex(
    (block) => isObject(block) && block["type"] === "text" && typeof block["text"] === "string" && block["text"].includes(PROMPT_CACHE_BOUNDARY),
  );
  if (index === -1) return body;

  const block = system[index] as Json & { text: string };
  const parts = splitAtBoundary(block.text)!;
  const { cache_control: existing, ...plain } = block;
  const breakpoint = existing ?? (countBreakpoints(body) < MAX_CACHE_BREAKPOINTS ? EPHEMERAL : undefined);

  const replacement: Json[] = [];
  if (parts.head !== "") replacement.push(breakpoint === undefined ? { ...plain, text: parts.head } : { ...plain, text: parts.head, cache_control: breakpoint });
  if (parts.tail !== "") replacement.push({ ...plain, text: parts.tail });

  return { ...body, system: [...system.slice(0, index), ...replacement, ...system.slice(index + 1)] };
}

/**
 * The openai-compatible lane: a Chat Completions request body. Only removes the marker from
 * system messages; there is no `cache_control` to place. Returns the SAME object when there is
 * nothing to do.
 */
export function stripBoundaryFromChatBody(body: unknown): unknown {
  if (!isObject(body) || !Array.isArray(body["messages"])) return body;
  let changed = false;
  const join = (text: string): string => {
    const parts = splitAtBoundary(text);
    if (parts === undefined) return text;
    changed = true;
    return [parts.head, parts.tail].filter((part) => part !== "").join("\n\n");
  };
  const messages = body["messages"].map((message) => {
    if (!isObject(message) || message["role"] !== "system") return message;
    const content = message["content"];
    if (typeof content === "string") return { ...message, content: join(content) };
    if (Array.isArray(content)) {
      return {
        ...message,
        content: content.map((part) => (isObject(part) && typeof part["text"] === "string" ? { ...part, text: join(part["text"]) } : part)),
      };
    }
    return message;
  });
  return changed ? { ...body, messages } : body;
}

/**
 * Applies `shape` to a JSON request body inside a fetch `init`. Anything it cannot read — no
 * body, a non-string body, a body that is not JSON — passes through untouched, and a body
 * `shape` leaves alone is not re-serialised.
 */
export function reshapeJsonBody(init: RequestInit | undefined, shape: (body: unknown) => unknown): RequestInit | undefined {
  if (init === undefined || typeof init.body !== "string" || !init.body.includes(PROMPT_CACHE_BOUNDARY)) return init;
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return init;
  }
  const shaped = shape(parsed);
  return shaped === parsed ? init : { ...init, body: JSON.stringify(shaped) };
}
