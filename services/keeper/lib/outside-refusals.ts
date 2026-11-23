import { KeeperRefusedError, registerAction, type Action } from "./actions.js";
import { OutsideRefusal } from "./outside-custody.js";

/** What the owner is told when the keeper refused an outside-tool step before any exchange with the server. The check
 * code is a fixed label and goes into the sentence so the keeper log and the screen name the same check. Anything not
 * listed gets the general sentence: it is still true (nothing was sent) and still names the check. */
const SENTENCES: Readonly<Record<string, string>> = {
  "capacity.operations": "Lares keeps a fixed number of saved attempts for each connection, and this one has used them all. Removing the half-set-up connection does not free them yet. Use a different connection name for now.",
  "capacity.revisions": "Lares keeps a fixed number of saved tokens for each connection, and this one has used them all. Removing the half-set-up connection does not free them yet. Use a different connection name for now.",
  "claim.account-moved-on": "Another attempt changed this connection while this screen was open. Press Start over.",
  "claim.consent-moved-on": "Another attempt changed this connection while this screen was open. Press Start over.",
  "phase2.account-moved-on": "Another attempt changed this connection while this screen was open. Press Start over.",
  "claim.request-replayed": "This request was already used. Press Start over.",
  "claim.capture-mismatch": "The agent changed while this screen was open. Press Start over.",
  "claim.destination-changed": "The server address changed while this screen was open. Press Start over.",
  "claim.route-changed": "The keeper's route to this server changed while this screen was open. Press Start over.",
};

/** The refusal the screen can show, or undefined to leave the error as it is (it is then logged with its check code). */
export function plainOutsideRefusal(error: unknown): KeeperRefusedError | undefined {
  if (!(error instanceof OutsideRefusal)) return undefined;
  const sentence = SENTENCES[error.code]
    ?? "The keeper refused this step before it contacted the server, so nothing was sent. The keeper log names the check.";
  return new KeeperRefusedError(`${sentence} (check: ${error.code})`);
}

/** Registers a private outside action so a named refusal reaches the screen as a plain sentence. Other errors pass through. */
export function registerWithPlainRefusals<I, O>(action: Action<I, O>): void {
  registerAction({ ...action, run: async (input, ctx) => {
    try { return await action.run(input, ctx); }
    catch (error) { throw plainOutsideRefusal(error) ?? error; }
  } });
}
