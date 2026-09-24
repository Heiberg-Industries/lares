/**
 * W7D-s2 — owner decision D3 (`.claude/plans/2026-09-20-prelaunch-wave-7.md`): every mail read
 * says whether its sender is someone the owner has written to before, in one of exactly three
 * sentences. It never says "trusted" — being in the owner's own outbox is not a vouch for the
 * sender, only a fact about the relationship the owner can weigh for himself.
 *
 * The lookup is `isKnownRecipient` (`./contact-history.js`) — the SAME function
 * `board-approval.ts` already uses to decide whether a send may skip its "first contact" card.
 * This is deliberately not a second implementation of "has the owner written to this address":
 * `isKnownRecipient`'s Gmail assumptions (the `in:sent` search plus per-message header
 * verification) already carry their own committed live probe,
 * `tests/live/contact-history-gmail.live.mts` — nothing here adds a new branch on a Gmail
 * response shape, only a new caller of an existing, already-probed one.
 *
 * The answer is judged on the sender's ADDRESS, exactly as Gmail reports the `From` header —
 * never the display name. `"Known Person <stranger@evil.example>"` is judged on
 * `stranger@evil.example`: the address is pulled out with `contact-history.ts`'s own
 * `addressOf` (imported, not copied, so the two can never quietly diverge on the same
 * question). A `from` that is not a string, or that does not parse to EXACTLY one address
 * (several addresses, or none — `addressOf` answers `""` for anything it cannot resolve to one
 * genuine address, and a raw multi-address header never looks like one address either) answers
 * "I could not check" without ever calling the lookup.
 *
 * A lookup that throws, or one that has not settled within `SENDER_STANDING_TIMEOUT_MS`, also
 * answers "I could not check" — never a throw that costs the owner his mail, and never "nobody
 * you have written to" (a false statement) for a sender that could not actually be checked.
 */
import { addressOf, isKnownRecipient } from "./contact-history.js";

export type SenderStanding =
  | "you have written to them before"
  | "nobody you have written to"
  | "I could not check";

export const SENDER_STANDING_TIMEOUT_MS = 5_000;

/**
 * A loose, LOCAL check that `addressOf`'s result is exactly one plausible email address — not
 * a second copy of `always-ask.ts`'s stricter `ADDRESS_RE`/`parseSingleAddress`. That parser
 * stays exactly as strict as it is for recipients the agent is about to WRITE to (this file
 * does not touch it, per the plan); this one only has to reject the "several addresses, or
 * none" case for a sender the agent is reading FROM, where `addressOf` has already collapsed
 * anything it cannot resolve to one address down to `""`.
 */
const LOOKS_LIKE_ONE_ADDRESS = /^[^\s,;<>@]+@[^\s,;<>@]+\.[^\s,;<>@]+$/;

/** Settles with whichever of `promise` or the timeout comes first. The loser is abandoned —
 *  its eventual result, if any, is never observed. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sender-standing lookup timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Never throws, never blocks a read for long: a slow or failing lookup answers
 * "I could not check", which is neither a vouch nor an accusation.
 *
 * `deps.known` stands in for `isKnownRecipient` in tests; `deps.timeoutMs` stands in for
 * `SENDER_STANDING_TIMEOUT_MS`.
 */
export async function senderStanding(
  from: unknown,
  deps?: { known?: (addr: string) => Promise<boolean>; timeoutMs?: number },
): Promise<SenderStanding> {
  if (typeof from !== "string") return "I could not check";

  const addr = addressOf(from);
  if (!LOOKS_LIKE_ONE_ADDRESS.test(addr)) return "I could not check";

  const known = deps?.known ?? ((a: string) => isKnownRecipient(a, {}));
  const timeoutMs = deps?.timeoutMs ?? SENDER_STANDING_TIMEOUT_MS;

  try {
    const found = await raceTimeout(known(addr), timeoutMs);
    return found ? "you have written to them before" : "nobody you have written to";
  } catch {
    return "I could not check";
  }
}
