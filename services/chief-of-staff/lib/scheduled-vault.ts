/**
 * How a SCHEDULE (the nightly memory cycle, the clipping drain) reads and saves Vault notes when this
 * agent has no Vault folder: through keeper's `vault.scheduled` operation, which applies the same
 * checks a model-called tool gets and only lets a named schedule touch the paths it needs
 * (`@lares/agent-kit/scheduled-vault-policy`). On an install that still mounts a Vault folder
 * (`VAULT_PATH` set) the schedules keep reading and writing it directly; `scheduledVaultMounted`
 * is the one test for that.
 *
 * A keeper write is a commit (and a push to the area's origin), so every write here is one commit.
 * A refusal or an outage THROWS: never "no such note" and never a silent skip, because a schedule
 * that read "nothing there" from a refused request would act on a wrong picture.
 */
import { Buffer } from "node:buffer";

import { StorePathNotConfiguredError, storeRoot } from "@lares/agent-kit/notes-store";
import { vaultBrokerRequest, SCHEDULED_VAULT_TIMEOUT_MS } from "@lares/agent-kit/vault-broker-client";
import {
  SCHEDULED_VAULT_MAX_BODY_BYTES, type ScheduledVaultArea, type ScheduledVaultOperation,
} from "@lares/agent-kit/scheduled-vault-policy";

export type ScheduleName = "dream" | "clipping-requests" | "digest";

export type BrokerRequest = (op: string, input: unknown, timeoutMs?: number) => Promise<any>;

/** True when this install gives the agent a Vault folder of its own, so the schedule uses the file path. */
export function scheduledVaultMounted(env: NodeJS.ProcessEnv = process.env): boolean {
  try { storeRoot("brain", env); return true; }
  catch (e) { if (e instanceof StorePathNotConfiguredError) return false; throw e; }
}

export class ScheduledVaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = "ScheduledVaultError"; }
}
export class ScheduledVaultTooLargeError extends ScheduledVaultError {
  constructor(what: string) { super(`${what} is too large to send to the Vault in one piece`); this.name = "ScheduledVaultTooLargeError"; }
}

/** The one-line key/value front matter these schedules write, split from the text after it. Values stay strings. */
export function splitRawNote(raw: string): { frontmatter: Record<string, string>; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const colon = line.indexOf(":");
    const key = colon === -1 ? "" : line.slice(0, colon).trim();
    // A tab or other control character in a value would be refused by keeper; a space reads the same.
    if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) frontmatter[key] = line.slice(colon + 1).replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]/g, " ").trim();
  }
  const after = text.slice(end + 4).replace(/^\n/, "");
  return { frontmatter, body: after.replace(/^\n/, "") };
}

export interface ScheduledVault {
  /** Every note path under a folder the schedule is allowed to list (for example "_inbox/"), in order. */
  list(prefix: string): Promise<string[]>;
  /** The note's text, or undefined when there is no such note. */
  read(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
  /** Saves the note (replacing one already there); an identical note is left alone. One commit. */
  write(path: string, note: { frontmatter: Record<string, unknown>; body: string; message?: string }): Promise<{ commit: string | null }>;
  /** Saves note text that carries its own `---` front matter lines. */
  writeRaw(path: string, raw: string, message?: string): Promise<{ commit: string | null }>;
  /** Saves the whole file exactly as given (nothing added or rewritten); keeper checks the path and the origin the file carries. */
  writeVerbatim(path: string, content: string, message?: string): Promise<{ commit: string | null; unchanged: boolean }>;
  /** Drops the note; true when there was one. */
  remove(path: string): Promise<boolean>;
  move(path: string, destination: string): Promise<void>;
}

export function makeScheduledVault(
  schedule: ScheduleName, options: { area?: ScheduledVaultArea; request?: BrokerRequest } = {},
): ScheduledVault {
  const area = options.area ?? "private", request = options.request ?? vaultBrokerRequest;
  const call = async (operation: ScheduledVaultOperation, extra: Record<string, unknown>): Promise<any> => {
    try {
      return await request("vault.scheduled", { schedule, operation, area, ...extra }, SCHEDULED_VAULT_TIMEOUT_MS);
    } catch (e) {
      throw new ScheduledVaultError(`the Vault could not be reached or refused the ${schedule} schedule (${operation})`, { cause: e });
    }
  };
  const tooLarge = (body: string, path: string) => {
    if (Buffer.byteLength(body, "utf8") > SCHEDULED_VAULT_MAX_BODY_BYTES) throw new ScheduledVaultTooLargeError(`The note ${path}`);
  };
  const vault: ScheduledVault = {
    async list(prefix) {
      const paths: string[] = [];
      let cursor: string | undefined;
      // Bounded: a runaway cursor must end the pass, not loop it.
      for (let page = 0; page < 400; page++) {
        const r = await call("list", { prefix, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(r.paths)) throw new ScheduledVaultError("the Vault answered a listing in a shape this schedule does not know");
        paths.push(...(r.paths as string[]));
        if (typeof r.nextCursor !== "string") return paths;
        cursor = r.nextCursor;
      }
      throw new ScheduledVaultError(`the listing of ${prefix} did not end`);
    },
    async read(path) {
      const r = await call("read", { path });
      if (r.found !== true) return undefined;
      if (r.tooLarge === true) throw new ScheduledVaultTooLargeError(`The note ${path}`);
      if (typeof r.content !== "string") throw new ScheduledVaultError("the Vault answered a read in a shape this schedule does not know");
      return r.content;
    },
    async exists(path) {
      const r = await call("read", { path, probe: true });
      return r.found === true;
    },
    async write(path, note) {
      tooLarge(note.body, path);
      const r = await call("write", { path, frontmatter: note.frontmatter, body: note.body, ...(note.message ? { message: note.message } : {}) });
      return { commit: typeof r.commit === "string" ? r.commit : null };
    },
    async writeRaw(path, raw, message) {
      const { frontmatter, body } = splitRawNote(raw);
      return vault.write(path, { frontmatter, body, message });
    },
    async writeVerbatim(path, content, message) {
      tooLarge(content, path);
      const r = await call("write-verbatim", { path, content, ...(message ? { message } : {}) });
      return { commit: typeof r.commit === "string" ? r.commit : null, unchanged: r.unchanged === true };
    },
    async remove(path) {
      const r = await call("remove", { path });
      return r.removed === true;
    },
    async move(path, destination) { await call("move", { path, destination }); },
  };
  return vault;
}
