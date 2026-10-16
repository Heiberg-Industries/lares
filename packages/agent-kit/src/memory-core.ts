/**
 * memory-core.ts — the seam between a role service's per-session memory block and whatever
 * builds it (ADR-0018 rule 9, wave 4 slice W4B-s2).
 *
 * WHAT A "MEMORY CORE" IS, in plain language. It is the short block of what the owner has told
 * the agent that travels with every message of one conversation. It used to be rebuilt on every
 * single turn; it is now built once when the conversation starts and then left alone, because
 * the model provider's prompt cache is byte-exact: a block whose bytes change re-bills the whole
 * system prompt — persona, tool descriptions and memory together — on every message. See
 * `./clock.ts`'s header for how that was established out of the installed eve dist.
 *
 * WHY THIS INTERFACE EXISTS AT ALL, given that it is two lines. eve 0.32 has no memory slot of
 * its own, so today a role service implements this against `defineDynamic({ events: {
 * "session.started": … } })`. After the framework upgrade (ADR-0016 / the eve-upgrade spec) the
 * same provider is handed to eve instead. Keeping the shape here — with nothing eve-shaped in
 * it, and no import of eve anywhere in this file — is what makes that move a change in ONE file
 * rather than a rewrite of every role's instruction directory.
 *
 * NOTHING HERE READS A DATABASE, RENDERS MARKDOWN OR KNOWS WHAT A FACT IS. The provider does all
 * of that; this module only states the contract and supplies the safety net every implementation
 * of it needs.
 */

/**
 * What a role service's per-session memory resolver provides.
 *
 * Returns "" when there is nothing to say — an empty heading over nothing is worse than silence,
 * and eve drops an empty block entirely rather than reserving space for it (eve 0.32
 * `dist/src/context/dynamic-instruction-lifecycle.js`: a resolver returning empty markdown has
 * its slug deleted from the durable map, so it contributes no bytes at all).
 *
 * `forSession` is called once per session by construction; an implementation that caches by
 * `sessionId` must return the SAME bytes for the same session for the session's whole life, even
 * if the underlying store has changed in the meantime. That stability is the entire point — what
 * honours a change made mid-conversation is a separate, turn-scoped addendum, not a rebuild.
 */
export interface MemoryCoreProvider {
  forSession(sessionId: string): Promise<string>;
}

/**
 * Wrap a provider so a failure or a stall can never cost the turn it runs in.
 *
 * THE HOLE THIS CLOSES. eve takes a turn's whole instruction set down with a throwing resolver,
 * so a database hiccup while building the block would cost the owner the message they are in the
 * middle of, rather than costing the agent its memory for one conversation. And a `catch` only
 * covers a REJECTION: the failure a small box actually produces is a STALL — the database up but
 * unresponsive (a full disk, exhausted connections) — which neither resolves nor rejects, and
 * eve applies no timeout of its own to a dynamic-instruction resolver. Past `timeoutMs` this
 * returns "" instead of waiting.
 *
 * ONE LINE, NOT A SPRAY. The failure is logged once per call, and a call happens once per
 * session, so a box with a broken database produces one line per conversation — not one per
 * turn. A later session picks the block up when the store recovers.
 *
 * The bound is a race, not a cancellation: the underlying work keeps running and its result is
 * discarded. An implementation that writes to a cache must therefore apply its own bound around
 * the part whose late result would be wrong to keep — this wrapper cannot reach inside it.
 */
export function guarded(
  provider: MemoryCoreProvider,
  opts: { timeoutMs: number; label: string },
): MemoryCoreProvider {
  return {
    async forSession(sessionId: string): Promise<string> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          provider.forSession(sessionId),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`)),
              opts.timeoutMs,
            );
          }),
        ]);
      } catch (err) {
        console.error(
          `${opts.label}: no memory block for this session — the conversation runs without it, ` +
            "and a later session picks it up",
          err,
        );
        return "";
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
