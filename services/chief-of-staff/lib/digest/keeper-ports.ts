/**
 * The digest's Vault ports for an install with no Vault folder: every read and write goes through
 * keeper's `vault.scheduled` operation under the `digest` rule in
 * `@lares/agent-kit/scheduled-vault-policy`. An install that mounts a Vault folder keeps the file
 * ports in `agent/schedules/digest.ts`.
 *
 * FILING IS TWO STEPS. Move the inbox note to its place, then rewrite that note with the classified
 * front matter and summary. Move first: if the second step fails, the note is already out of the
 * inbox and sits (as it was saved) where it belongs, so the next pass cannot file the same note
 * twice. The other order (write, then remove the inbox note) leaves both copies behind on a
 * failure, and the next pass files it again under whatever title the model chooses then.
 * If the name is taken, the note takes the next free `-2`, `-3` ... name, because a move never
 * replaces a note that is already there.
 *
 * WHAT STAYS IN THE INBOX. Saved links (they are filed as articles, which need a text companion that
 * `vault.scheduled` cannot carry) and attachments (binary files it cannot read). Both wait; one line
 * in the log says how many, and says it again only when the count changes.
 */
import { Buffer } from "node:buffer";
import { basename, extname } from "node:path";

import type { InboxPort } from "../clipping/sync.js";
import { makeKeeperInbox } from "../clipping/step.js";
import { ScheduledVaultError, type ScheduledVault } from "../scheduled-vault.js";
import { classifyInbound } from "./detect.js";
import { parseFrontmatter, stripFrontmatter } from "./extract.js";
import { projectsFromPaths, type FileNoteFn } from "./filer.js";

export const ARTICLES_NOT_YET = "articles cannot be filed yet on this install";

const ATTACHMENT_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".docx"]);
const FREE_NAME_TRIES = 20;

/** What the inbox note is, if it is one the keeper-backed digest must leave where it is. */
export function heldInboxKind(body: string): "attachment" | "link" | null {
  const fm = parseFrontmatter(body);
  if (fm["attachment"] && ATTACHMENT_EXTS.has(extname(fm["attachment"]).toLowerCase())) return "attachment";
  if (fm["url"]) return "link";
  return classifyInbound(stripFrontmatter(body)).kind === "link" ? "link" : null;
}

/** Oldest save first: by the note's own `saved` time, undated ones after, ties by path. */
function savedMs(body: string): number {
  const t = Date.parse(parseFrontmatter(body)["saved"] ?? "");
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

let lastHeldLine = "";
/** Test seam: forget what was last logged. */
export function resetHeldLogForTests(): void { lastHeldLine = ""; }

const oneLine = (value: unknown): unknown =>
  typeof value === "string" ? value.replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]+/g, " ").trim() : value;

export interface KeeperDigestPorts {
  inbox: InboxPort;
  listInbox(): Promise<{ path: string; body: string }[]>;
  /** Karakeep's raw note into the inbox (one commit). */
  writeRawNote(relPath: string, body: string): Promise<void>;
  noteNames(): Promise<string[]>;
  projects(): Promise<string[]>;
  fileNote: FileNoteFn;
  readFile(rel: string): Promise<Buffer>;
}

/** One pass's ports. The whole-area listing is taken once and shared by the names and the projects. */
export function makeKeeperDigestPorts(vault: ScheduledVault, log: (m: string) => void = () => {}): KeeperDigestPorts {
  let listing: Promise<string[]> | undefined;
  const allPaths = () => (listing ??= vault.list("").catch((e) => { listing = undefined; throw e; }));

  return {
    inbox: makeKeeperInbox(vault),

    async listInbox() {
      // Flat only, like the folder listing it replaces: a note in a sub-folder is not the digest's.
      const paths = (await vault.list("_inbox/")).filter((p) => /^_inbox\/[^/]+\.md$/.test(p));
      const found: { path: string; body: string; at: number }[] = [];
      let links = 0, attachments = 0;
      for (const path of paths) {
        const body = await vault.read(path);
        if (body === undefined) continue; // filed or removed since the listing
        const held = heldInboxKind(body);
        if (held === "link") { links += 1; continue; }
        if (held === "attachment") { attachments += 1; continue; }
        found.push({ path, body, at: savedMs(body) });
      }
      const line = links + attachments === 0 ? "" :
        `${ARTICLES_NOT_YET}: ${links} saved link(s) and ${attachments} attachment(s) stay in the inbox`;
      if (line !== lastHeldLine) { lastHeldLine = line; if (line) log(line); }
      found.sort((a, b) => (a.at === b.at ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.at - b.at));
      return found.map(({ path, body }) => ({ path, body }));
    },

    async writeRawNote(relPath, body) { await vault.writeRaw(relPath, body); },

    async noteNames() { return (await allPaths()).map((p) => basename(p, ".md")); },

    async projects() { return projectsFromPaths(await allPaths()); },

    fileNote: async ({ destPath, sourcePath, frontmatter, body, message }) => {
      const clean = Object.fromEntries(Object.entries(frontmatter).map(([k, v]) => [k, oneLine(v)]));
      const note = { frontmatter: clean, body, message: String(oneLine(message)).slice(0, 200) };
      if (!sourcePath) return { commit: (await vault.write(destPath, note)).commit ?? "unchanged" };
      let dest = destPath;
      for (let n = 2; await vault.exists(dest); n++) {
        if (n > FREE_NAME_TRIES) throw new ScheduledVaultError(`no free name for ${destPath}`);
        dest = destPath.replace(/\.md$/, `-${n}.md`);
      }
      await vault.move(sourcePath, dest);
      return { commit: (await vault.write(dest, note)).commit ?? "unchanged" };
    },

    // Attachments are held in the inbox, so nothing asks for one; this refuses a stray request plainly.
    async readFile(rel) { throw new ScheduledVaultError(`the attachment ${rel} cannot be read yet on this install`); },
  };
}
