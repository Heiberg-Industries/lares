// The write-shape lint — a mutating tool under a `read` grant fails the build (ORB-199).
//
// ORB-144 left a standing finding and the 2026-09-01 sweep re-confirmed it
// (`docs/research/2026-09-01-engine-security-sweep.md`, layer 4): **no live instance, and
// nothing structural to catch the next one.** `assertClassMatchesScope` in `./manifest.ts`
// already fails the build in one direction — a tool that CARRIES an approval gate under a
// grant that is not `write-with-confirm`. This file is the other direction: a tool that
// carries NO gate, whose code mutates something anyway, under a grant of `read` or `none`.
//
// It is a TRIPWIRE, not a proof. It reads source text; it does not run the code, resolve types
// or prove reachability. It is designed so that today's fleet produces zero findings and a
// contributed adapter that POSTs to a third party under a `read` grant produces one.
//
// ---------------------------------------------------------------------------------------
// WHAT COUNTS AS WRITE-SHAPE
// ---------------------------------------------------------------------------------------
//
//   http-mutation    A fetch-shaped call with a literal `method: "PUT" | "PATCH" | "DELETE"`,
//                    or a `method: "POST"` that is not one of the read-shaped POST families
//                    below. PUT/PATCH/DELETE are unambiguous in HTTP semantics; POST is not,
//                    which is why only POST has exemptions.
//   sql-write        `INSERT INTO`, `UPDATE <t> SET`, `DELETE FROM`, `ON CONFLICT`, `UPSERT`
//                    inside a string or template literal (so a multi-line query is one match).
//   vendor-mutation  A TWO-segment member call — `x.y.send|insert|patch|update|delete|create|
//                    batchUpdate|batchDelete|batchCreate(` — which is the shape of a googleapis
//                    resource call (`api.events.insert(`, `api.users.messages.send(`).
//   graphql-mutation A GraphQL document whose operation keyword is `mutation`.
//   write-helper     A call to a named write helper this fleet's own libraries expose:
//                    `commitNote`, `moveNote`, `removeNote`, `writeRawNote` (the vault), and
//                    `twentyPost`, `twentyPatch`, `twentyDelete` (the CRM's REST verbs).
//                    Extend per call site with `opts.writeHelpers`.
//   store-fs-write   `writeFile(Sync)`, `appendFile(Sync)`, `rmSync`, `renameSync`, `unlink(Sync)`
//                    in a module that also touches the note store's own path/lock helpers —
//                    i.e. a vault write going around `commitNote`/`writeRawNote`, which is what
//                    "outside the store's own locking" means.
//
// ---------------------------------------------------------------------------------------
// WHAT IS EXEMPT, AND WHY — every exemption below is here because a REAL file in this repo
// forced it. A pattern set with no exemptions would redden the whole fleet on day one and be
// deleted by the second person who hit it.
// ---------------------------------------------------------------------------------------
//
//   own-door         The agent's own conversational output is not an external mutation. This
//                    is the sweep's own lesson, verbatim: Marcel's three layer-4 flags "dissolve
//                    on inspection — Telegram channel sends (the agent's own conversational
//                    output), not external mutations". So a call whose URL names the Telegram
//                    Bot API or Slack's chat.* methods is NOT write-shape, at any verb.
//                    Evidence: `services/travel/lib/telegram-photo.ts:120` (`/bot${token}/
//                    sendPhoto`), `services/travel/lib/telegram-commands.ts:57` (`${TELEGRAM
//                    _API}/bot${token}/setMyCommands`).
//                    THE LIMIT, stated plainly: a channel send addressed to a THIRD PARTY is
//                    indistinguishable from one addressed to the owner here. This exemption
//                    trusts the door, not the recipient.
//
//   graphql-query    A POST carrying a GraphQL document that is a `query` (no `mutation`
//                    keyword) is a read. GraphQL has no read verb — every read is a POST.
//                    Evidence: `packages/agent-kit/src/entur-client.ts:566-570`
//                    (`body: JSON.stringify({ query: TRIP_QUERY, variables })`), reached by
//                    `agent-kit__transit_plan` and `transit_directions`, both under
//                    `transit: read`.
//
//   read-endpoint    A POST whose ENDPOINT names a lookup rather than a mutation. Judged on a
//                    window built from the request URL expression, the module-local constants
//                    and helper functions that expression resolves through, the enclosing
//                    function's name, and the names of the module's own functions that call it
//                    (that last hop exists solely because a transport helper is often named for
//                    its verb, not its job — see `google-places.ts` below). A write-shaped token
//                    anywhere in the call vetoes the exemption.
//                    Evidence, all reached at depth 1 from a `read`-granted tool:
//                      - `packages/agent-kit/src/readability-client.ts:74` — POST to
//                        `extractUrl()` → `/extract`; tool `read_url` under `read_url: read`.
//                      - `services/travel/lib/google-places.ts:82` — POST to
//                        `` `${BASE}/${path}` ``, inside a transport helper literally named
//                        `post`. Only its callers say what it is: `searchText`, `searchNearby`.
//                        Tools `nearby_places` and `place_link` under `places: read`. This one
//                        file is the entire reason for the caller hop.
//                      - `services/travel/lib/nearby.ts:41` — POST to `OVERPASS_URL` →
//                        `…/api/interpreter`; enclosing function `search`. Same two tools.
//                      - `packages/agent-kit/src/markets/polymarket-clob-client.ts:34` — POST to
//                        `` `${baseUrl}/prices` ``; tool `agent-kit__market_edge` under
//                        `markets: read`.
//                      - `services/chief-of-staff/lib/embeddings-gateway.ts:23` — POST to
//                        `/v1/embeddings`. An inference call, not a mutation.
//
//   oauth-token      A POST to a token/OAuth endpoint is authentication, not a mutation of
//                    anyone's records — and a read tool may be REQUIRED to make it.
//                    Evidence: `services/travel/lib/strava.ts:61` posts to `TOKEN_URL`
//                    to refresh, and `strava.ts:76` says why it cannot be avoided: the refresh
//                    token is "ROTATED — persist or lose access". Tool `strava_routes` under
//                    `strava: read`. (Folded into read-endpoint's token list; named separately
//                    here because the reasoning is different.)
//
//   raw fs writes    `node:fs` writes OUTSIDE the note store are deliberately NOT write-shape.
//                    A file inside the container is not a third party and not what "ungated
//                    write" means. Evidence: `services/travel/lib/trip-store.ts:88-175`
//                    (Marcel's own trip files — read by `weather_forecast`, `trip_status`,
//                    `place_link` and `nearby_places`, three of which are `read`-granted) and
//                    `services/travel/agent/tools/strava_routes.ts:93-94` (the rotated
//                    OAuth token cache, under `strava: read`). The vault is the one local store
//                    that publishes outward, and it is reached through NAMED helpers — which is
//                    why those names, not `node:fs`, are the marker.
//
//   in-memory `.delete`/`.update`  The two-segment requirement on `vendor-mutation` exists to
//                    exclude collection and crypto calls that share the vendor verbs.
//                    Evidence: `packages/agent-kit/src/notes-store.ts:135,144`
//                    (`CONTENT_CACHE.delete(abs)` — a `Map`), `services/travel/lib/
//                    live-location.ts:60,70` (`store.delete(chatId)` — a `Map`),
//                    `packages/agent-kit/src/google-auth.ts:94` (`decipher.update(ct)` — Node
//                    crypto). All three are one segment; `api.events.insert(` is two.
//
//   comments         Comments are stripped before ANY rule runs. Evidence:
//                    `packages/agent-kit/src/markets/types.ts:7` names "Upsert/RecordMatch/…"
//                    in prose, and this repo's files carry long explanatory headers that talk
//                    about writes constantly.
//
// ---------------------------------------------------------------------------------------
// THE DEPTH RULE — one hop
// ---------------------------------------------------------------------------------------
//
// A tool's sources are: its own file, plus the modules it imports DIRECTLY (relative imports,
// and `@lares/agent-kit/<sub>` into this package's `src/`). Not two hops.
//
// Two hops was tried first and is wrong, for a reason no finer granularity fixes: at two hops
// you reach SHARED CONNECTOR modules that hold a capability's read and write halves in one
// file. `services/chief-of-staff/lib/google.ts` exports `googleClients()`, whose Gmail client can
// `api.users.messages.send` (`google.ts:241`) and whose Calendar client can `api.events.insert`
// / `.patch` / `.delete` (`google.ts:600,613,626`). `person_lookup` — a pure read under
// `person: read` — reaches that module via `lib/person-sources.ts:23`. At depth 2 the lint
// reports `person_lookup` for a Gmail send it never calls. Symbol-level scoping does not rescue
// it either: what `person-sources.ts` imports is the FACTORY, not a read function.
//
// One hop is where a contributed adapter's own write lives — in the tool file, or in the client
// module that ships beside it. What one hop gives up is a write buried behind an EXISTING shared
// client, and that case is already covered from the other side: such a tool carries an approval
// gate, and `assertClassMatchesScope` (ORB-144) fails the build when a gated tool sits under a
// grant that is not `write-with-confirm`. The two checks meet in the middle.
//
// One thing that is NOT a hop: the thin re-export a service ships for a kit extension tool.
// `services/<svc>/agent/extensions/agent-kit/tools/<n>.ts` is three lines of
// `resolveExtensionTool`; the real body is `packages/agent-kit/extension/tools/<n>.ts`. Both are
// read at depth 0, and the body's own imports are the one hop.
//
// ---------------------------------------------------------------------------------------
// KNOWN LIMITS (say them out loud rather than let a reader assume otherwise)
// ---------------------------------------------------------------------------------------
//
//   - A `method` passed as a VARIABLE is invisible to the http rule. `services/chief-of-staff/lib/
//     twenty-client.ts:71` is exactly that shape (`request(method, path, body)`), which is why
//     `twentyPost`/`twentyPatch` are in the write-helper list instead.
//   - Reachability is not proven. A write in an imported module counts even if the tool never
//     calls it. That is the deliberate trade for a lint that runs in milliseconds.
//   - A vendor SDK whose mutation is not a two-segment member call, or is not named for what it
//     does, is not detected. Add its helper name to `WRITE_HELPERS` when one arrives.
//
// This header is the contributed-adapter checklist text of the future: an adapter must either
// come in under a `write`-class grant, or its call patterns must fall inside the exemptions
// above, with the reason written down.
//
// No credential reads and no I/O at module scope. Build- and test-time only: nothing an agent
// boots imports this file.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CAPABILITY_DOCS } from "./persona/capability-docs.js";
import { deployedToolsFor } from "./persona/deployed-tools.js";
import {
  grantFor,
  skillToolsFor,
  scopeAtLeast,
  KNOWN_SKILLS,
  type AgentManifest,
  type Scope,
} from "./manifest.js";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const WRITE_SHAPE_RULES = [
  "http-mutation",
  "sql-write",
  "vendor-mutation",
  "graphql-mutation",
  "write-helper",
  "store-fs-write",
] as const;
export type WriteShapeRule = (typeof WRITE_SHAPE_RULES)[number];

export interface WriteShapeMatch {
  rule: WriteShapeRule;
  /** The matched text, trimmed to something readable in an error message. */
  match: string;
  /** 1-based line in the source that was classified. */
  line: number;
}

/** The named write helpers this fleet's own libraries expose. A call to one of these IS the
 *  write — the HTTP verb is a variable one layer down and cannot be seen from here. */
export const WRITE_HELPERS: readonly string[] = [
  // packages/agent-kit/src/vault-git.ts — git-backed vault publish.
  "commitNote",
  "moveNote",
  "removeNote",
  // packages/agent-kit/src/vault-raw.ts — uncommitted vault write.
  "writeRawNote",
  // services/chief-of-staff/lib/twenty-client.ts:106 — the CRM's REST write verbs. `request()` takes
  // the method as a parameter, so `method: "POST"` never appears as a literal.
  "twentyPost",
  "twentyPatch",
  "twentyDelete",
];

/** Tokens that mark an endpoint as a READ. Matched as WORDS — never as substrings — against the
 *  request URL expression, the module-local constants and helpers it resolves through, the
 *  enclosing function's name, and the names of module functions that call it.
 *
 *  Substring matching was tried first and is dangerously wrong: `POST /v1/widgets` reads as a
 *  "get" (wid-**get**-s) and is silently exempted. `wordsOf` splits on non-alphanumerics AND on
 *  camelCase boundaries, so `places:searchText` yields `search`, and a simple plural (`prices` ->
 *  `price`, `embeddings` -> `embedding`) still matches. */
const READ_ENDPOINT_TOKENS: readonly string[] = [
  "search", "lookup", "query", "extract", "read", "list", "find", "get",
  "plan", "planner", "route", "direction", "nearby", "geocode", "forecast",
  "price", "quote", "interpreter", "overpass", "embedding", "completion", "resolve",
  // oauth-token, folded in: authentication is not a mutation of anyone's records.
  "oauth", "token",
];

/** A write-shaped token vetoes a read-endpoint exemption — a `POST /search/create` must not be
 *  rescued by the word "search" beside it. Tested against the same window, so it sees the URL a
 *  constant resolves to and not merely the identifier naming it. */
const WRITE_ENDPOINT_VETO = /\bmutation\b|[/:.](create|update|delete|insert|upsert|remove|append)\b/i;

/** The agent's own door. Not write-shape at any verb — the sweep's lesson. */
const OWN_DOOR_TOKENS: readonly string[] = [
  "api.telegram.org", "/bot${", "sendmessage", "sendphoto", "senddocument",
  "sendchataction", "editmessagetext", "answercallbackquery", "setmycommands",
  "chat.postmessage", "chat.update", "slack.com/api/", "tgsend", "sendtelegrammessage",
];

/** Note-store markers. An fs write in a module carrying one of these is a vault write going
 *  around the store's own locking; an fs write anywhere else is a container-local file. */
const NOTE_STORE_MARKERS: readonly string[] = [
  "notes-store", "note-lock", "note-paths", "vault-git", "vault-raw",
  "storeRoot", "resolveInStore", "withNoteLock", "vaultRoot",
];

const FS_WRITE_CALL =
  /(?:^|[^\w$.])(writeFile|writeFileSync|appendFile|appendFileSync|rmSync|renameSync|unlink|unlinkSync)\s*\(/g;

/** Group 1 is the receiver segment, group 2 the verb — `api.events.insert(` -> `events`,
 *  `insert`. Two segments are required so a `Map`'s `.delete(` is not a vendor call. */
const VENDOR_MUTATION =
  /\.\s*([\w$]+)\s*\.\s*(send|insert|patch|update|delete|create|batchUpdate|batchDelete|batchCreate)\s*\(/g;

/** Receiver names that make a `.send(` the agent's own door rather than a vendor mutation —
 *  the sweep's lesson, applied to the member-call rule. Evidence:
 *  `services/travel/lib/bookings.ts:767` (`this.deps.tg.send(adminId, …)`), which is two
 *  segments and would otherwise read exactly like Gmail's `api.users.messages.send(`. */
const CHANNEL_RECEIVERS: ReadonlySet<string> = new Set([
  "tg", "telegram", "slack", "chat", "bot", "channel", "dm", "door", "notifier",
]);

const HTTP_METHOD_LITERAL = /(?:^|[^\w$])method\s*:\s*(["'`])(POST|PUT|PATCH|DELETE)\1/gi;

const SQL_WRITE_PATTERNS: readonly RegExp[] = [
  /\binsert\s+into\b/i,
  /\bupdate\s+[a-z_][\w.$"]*\s+set\b/i,
  /\bdelete\s+from\b/i,
  /\bon\s+conflict\b/i,
  // No trailing \b: `upsert_market($1)` is a write, and `_` is a word character.
  /\bupsert/i,
];

const GRAPHQL_MUTATION = /\bmutation\b\s*[\w$]*\s*[({]/;

// ---------------------------------------------------------------------------
// Source scanning primitives
// ---------------------------------------------------------------------------

interface StrippedSource {
  /** Same length as the input, with comment bodies replaced by spaces so every index and line
   *  number still lines up with the original file. */
  code: string;
  /** [start, end) spans of string and template literals in `code`. */
  literals: Array<[number, number]>;
}

/** Characters after which a `/` starts a regex literal rather than a division. The standard
 *  heuristic; it is here so a regex containing `//` or `/*` is not read as a comment. */
const REGEX_ALLOWED_BEFORE = new Set("(,=:[!&|?{};+-*%~^<>".split(""));
const REGEX_ALLOWED_KEYWORDS = ["return", "typeof", "case", "in", "of", "new", "delete", "void", "yield"];

function regexCanStartAt(code: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  if (j < 0) return true;
  const c = code[j]!;
  if (REGEX_ALLOWED_BEFORE.has(c)) return true;
  if (!/[\w$]/.test(c)) return false;
  let k = j;
  while (k >= 0 && /[\w$]/.test(code[k]!)) k--;
  return REGEX_ALLOWED_KEYWORDS.includes(code.slice(k + 1, j + 1));
}

/** Blank every comment, keeping offsets and newlines exact, and record literal spans.
 *  Handles `'`/`"`/backtick strings (with `${}` re-entering code), line and block comments,
 *  and regex literals. */
export function stripComments(source: string): StrippedSource {
  const out = source.split("");
  const literals: Array<[number, number]> = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") { out[i] = " "; i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    if (c === "/" && regexCanStartAt(source, i)) {
      // Skip a regex literal wholesale — never scanned for rules, never a literal span.
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = source[j]!;
        if (d === "\\") { j += 2; continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        else if (d === "\n") break; // not a regex after all
        j++;
      }
      if (j < n && source[j] === "/") { i = j + 1; continue; }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === c || source[i] === "\n") break;
        i++;
      }
      i++;
      literals.push([start, Math.min(i, n)]);
      continue;
    }
    if (c === "`") {
      const start = i;
      i++;
      while (i < n) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === "$" && source[i + 1] === "{") {
          // Re-enter code; the literal span still covers the whole template, which is what the
          // SQL rule wants (a query interpolating a table name is still one query).
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") depth--;
            i++;
          }
          continue;
        }
        if (source[i] === "`") break;
        i++;
      }
      i++;
      literals.push([start, Math.min(i, n)]);
      continue;
    }
    i++;
  }
  return { code: out.join(""), literals };
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function snippet(text: string, max = 90): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

interface EnclosingCall {
  callee: string;
  /** Everything between the call's parentheses. */
  args: string;
  /** The first argument, i.e. the request URL expression for a fetch-shaped call. */
  firstArg: string;
  start: number;
}

/** The call expression containing `index`, found by balancing brackets backwards. Returns null
 *  when there is no enclosing call (a bare object literal, say). */
function enclosingCall(code: string, index: number): EnclosingCall | null {
  let depth = 0;
  let open = -1;
  for (let i = index; i >= 0; i--) {
    const c = code[i]!;
    if (c === ")" || c === "}" || c === "]") depth++;
    else if (c === "(" || c === "{" || c === "[") {
      if (depth === 0) {
        if (c === "(") { open = i; break; }
        continue; // an enclosing object/array literal — keep walking out
      }
      depth--;
    }
  }
  if (open < 0) return null;
  let j = open - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  let end = j;
  while (j >= 0 && /[\w$.[\]"'`]/.test(code[j]!)) j--;
  const callee = code.slice(j + 1, end + 1);
  if (callee === "") return null;
  // Forward to the matching close paren.
  let d = 1;
  let k = open + 1;
  while (k < code.length && d > 0) {
    const c = code[k]!;
    if (c === "(" || c === "{" || c === "[") d++;
    else if (c === ")" || c === "}" || c === "]") d--;
    if (d === 0) break;
    k++;
  }
  const args = code.slice(open + 1, k);
  // First argument: up to the first comma at depth 0.
  let fd = 0;
  let comma = args.length;
  for (let m = 0; m < args.length; m++) {
    const c = args[m]!;
    if (c === "(" || c === "{" || c === "[") fd++;
    else if (c === ")" || c === "}" || c === "]") fd--;
    else if (c === "," && fd === 0) { comma = m; break; }
  }
  return { callee, args, firstArg: args.slice(0, comma).trim(), start: open };
}

interface FunctionDecl {
  name: string;
  index: number;
}

/** Every function-ish declaration in the module, in source order: `function f(`, `const f = `,
 *  `async f(` / `f(` as an object method or class member. Names only — this is used to answer
 *  "what is this call FOR", not to build a scope tree. */
function functionDecls(code: string): FunctionDecl[] {
  const out: FunctionDecl[] = [];
  const patterns: RegExp[] = [
    /\bfunction\s+([\w$]+)\s*\(/g,
    /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\()/g,
    /(?:^|[\s,{])(?:async\s+)?([\w$]+)\s*\([^()]*\)\s*(?::[^{;=]*)?\{/gm,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    const re = new RegExp(p.source, p.flags);
    while ((m = re.exec(code)) !== null) out.push({ name: m[1]!, index: m.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** The declaration whose body most likely contains `index` — the nearest one before it. */
function enclosingDeclName(decls: FunctionDecl[], index: number): string {
  let best = "";
  for (const d of decls) {
    if (d.index > index) break;
    best = d.name;
  }
  return best;
}

/** Names of module functions whose region calls `name`. One level, and only within the module.
 *  This exists for `services/travel/lib/google-places.ts`, whose POST sits in a transport
 *  helper called `post` and whose only callers — `searchText`, `searchNearby` — say what it is. */
function callersOf(code: string, decls: FunctionDecl[], name: string): string[] {
  if (name === "") return [];
  const call = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\s*\\(`);
  const out: string[] = [];
  for (let i = 0; i < decls.length; i++) {
    const d = decls[i]!;
    if (d.name === name) continue;
    const end = decls[i + 1]?.index ?? code.length;
    if (call.test(code.slice(d.index, end))) out.push(d.name);
  }
  return out;
}

/** Text of every module-local `const/let/var <id> = …` binding named in `expr`, plus the body
 *  region of every `<id>()` it calls. One level — enough to turn `TOKEN_URL`, `extractUrl()`
 *  and `endpoint` into the URL they stand for, and no more. */
function resolveIdentifiers(code: string, decls: FunctionDecl[], expr: string): string {
  const ids = new Set((expr.match(/[A-Za-z_$][\w$]*/g) ?? []).slice(0, 12));
  let out = "";
  for (const id of ids) {
    const bind = new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*(?::[^=\\n]*)?=\\s*([^\\n;]*)`).exec(code);
    if (bind) out += ` ${bind[1]}`;
    const decl = decls.find((d) => d.name === id);
    if (decl) {
      const next = decls.find((d) => d.index > decl.index);
      out += ` ${code.slice(decl.index, Math.min(next?.index ?? code.length, decl.index + 400))}`;
    }
  }
  return out;
}

/** Substring match, for tokens distinctive enough that a substring cannot lie —
 *  `api.telegram.org`, `sendphoto`, `notes-store`. */
function hasToken(haystack: string, tokens: readonly string[]): boolean {
  const h = haystack.toLowerCase();
  return tokens.some((t) => h.includes(t));
}

/** Lowercased words of `text`, split on non-alphanumerics AND camelCase boundaries. */
function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const chunk of text.split(/[^A-Za-z0-9]+/u)) {
    if (chunk === "") continue;
    for (const w of chunk.split(/(?<=[a-z0-9])(?=[A-Z])/u)) out.add(w.toLowerCase());
  }
  return out;
}

/** Word match with a simple plural, for short tokens where a substring would lie: `widgets`
 *  contains `get`, `forecast` contains `cast`. `prices` still matches `price`. */
function hasWord(haystack: string, tokens: readonly string[]): boolean {
  const words = wordsOf(haystack);
  return tokens.some((t) => words.has(t) || words.has(`${t}s`) || words.has(`${t}es`));
}

// ---------------------------------------------------------------------------
// classifyWriteShape — one file
// ---------------------------------------------------------------------------

export interface ClassifyOptions {
  /** Additional named write helpers, on top of `WRITE_HELPERS`. */
  writeHelpers?: readonly string[];
}

/** Every write-shaped pattern in ONE file's source, with the rule and the 1-based line.
 *  Comments are stripped first; see this file's header for what counts and what is exempt. */
export function classifyWriteShape(source: string, opts: ClassifyOptions = {}): WriteShapeMatch[] {
  const { code, literals } = stripComments(source);
  const found: WriteShapeMatch[] = [];
  const decls = functionDecls(code);
  const add = (rule: WriteShapeRule, match: string, index: number): void => {
    found.push({ rule, match: snippet(match), line: lineAt(source, index) });
  };

  // --- SQL writes and GraphQL mutations, inside string/template literals only.
  for (const [start, end] of literals) {
    const text = code.slice(start, end);
    for (const p of SQL_WRITE_PATTERNS) {
      const m = p.exec(text);
      if (m) { add("sql-write", m[0], start + m.index); break; }
    }
    const gm = GRAPHQL_MUTATION.exec(text);
    if (gm) add("graphql-mutation", gm[0], start + gm.index);
  }

  // --- Vendor mutation calls: two member segments, so a Map's `.delete(` is not one.
  {
    const re = new RegExp(VENDOR_MUTATION.source, VENDOR_MUTATION.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (m[2] === "send" && CHANNEL_RECEIVERS.has(m[1]!.toLowerCase())) continue; // own door
      add("vendor-mutation", m[0], m.index);
    }
  }

  // --- Named write helpers. The optional `<…>` is TypeScript type arguments:
  // `twentyPost<unknown>("/opportunities", payload)` is the live call shape
  // (services/chief-of-staff/agent/tools/twenty_create_opportunity.ts:39).
  {
    const names = [...WRITE_HELPERS, ...(opts.writeHelpers ?? [])];
    if (names.length > 0) {
      const re = new RegExp(`\\b(${names.join("|")})\\s*(?:<[^<>()]*>)?\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        // A DECLARATION is not a call. Without this, every module that merely defines a write
        // verb taints every tool importing it: `services/chief-of-staff/lib/twenty-client.ts:106`
        // exports `twentyPost`, and `twenty_lookup`/`twenty_get_person` — pure reads that only
        // call `twentyGet` — import that module at depth 1.
        if (/\b(?:function|const|let|var)\s+$/.test(code.slice(Math.max(0, m.index - 24), m.index))) continue;
        add("write-helper", m[0], m.index);
      }
    }
  }

  // --- fs writes, but only inside a module that touches the note store.
  if (hasToken(code, NOTE_STORE_MARKERS.map((t) => t.toLowerCase()))) {
    const re = new RegExp(FS_WRITE_CALL.source, FS_WRITE_CALL.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) add("store-fs-write", m[1]!, m.index);
  }

  // --- HTTP mutations, with the POST families exempted.
  {
    const re = new RegExp(HTTP_METHOD_LITERAL.source, HTTP_METHOD_LITERAL.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const verb = m[2]!.toUpperCase();
      const call = enclosingCall(code, m.index);
      const callText = call ? `${call.callee}(${call.args})` : code.slice(Math.max(0, m.index - 200), m.index + 200);
      const urlExpr = call?.firstArg ?? "";
      const fnName = enclosingDeclName(decls, m.index);
      const window = [
        urlExpr,
        resolveIdentifiers(code, decls, urlExpr),
        fnName,
        callersOf(code, decls, fnName).join(" "),
      ].join(" ");

      // own-door: the agent's own conversational channel, at any verb (the sweep's lesson).
      if (hasToken(`${window} ${callText}`, OWN_DOOR_TOKENS)) continue;

      if (verb !== "POST") { add("http-mutation", `method: "${verb}"`, m.index); continue; }

      // graphql-query: a GraphQL read. GraphQL has no read verb, so every read is a POST.
      // The body is resolved through module-local constants first — the document is almost
      // always a `const TRIP_QUERY = \`query …\`` named at the call site, not inlined there.
      const bodyText = `${call?.args ?? ""} ${resolveIdentifiers(code, decls, call?.args ?? "")}`;
      const graphqlish = /\bquery\s*:/.test(call?.args ?? "") || /\bquery\s+[\w$]*\s*[({]/.test(bodyText);
      if (graphqlish && !/\bmutation\b/i.test(bodyText)) continue;

      // read-endpoint (incl. oauth-token), unless a write token vetoes it. Both are judged on
      // the resolved window, so a URL hiding behind a constant is read either way.
      if (hasWord(window, READ_ENDPOINT_TOKENS) && !WRITE_ENDPOINT_VETO.test(`${window} ${callText}`)) continue;

      add("http-mutation", `method: "POST"`, m.index);
    }
  }

  return found.sort((a, b) => a.line - b.line || WRITE_SHAPE_RULES.indexOf(a.rule) - WRITE_SHAPE_RULES.indexOf(b.rule));
}

// ---------------------------------------------------------------------------
// The tool -> capability map
// ---------------------------------------------------------------------------

/** The capability whose doc lists `tool`, or the capabilities a code SKILL serving `tool`
 *  composes. Returns `[]` when nothing claims the tool — which is itself a finding. */
export function capabilitiesForTool(tool: string): string[] {
  const out: string[] = [];
  for (const doc of Object.values(CAPABILITY_DOCS)) {
    if (doc.tools.includes(tool)) out.push(doc.capability);
  }
  if (out.length > 0) return out;
  // A code skill has no capability doc of its own; it composes the ones its declaration names.
  for (const skill of KNOWN_SKILLS) {
    if (skillToolsFor(skill).includes(tool)) return [`skill:${skill}`];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source resolution — the depth rule, implemented
// ---------------------------------------------------------------------------

export interface ToolSource {
  file: string;
  source: string;
}

const KIT_ROOT = resolve(import.meta.dirname, "..");
const KIT_SRC = join(KIT_ROOT, "src");
const KIT_EXTENSION_TOOLS = join(KIT_ROOT, "extension", "tools");

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** `./foo.js` -> `./foo.ts`, `./foo` -> `./foo.ts` or `./foo/index.ts`. */
function resolveModuleFile(candidate: string): string | null {
  const tries = [
    candidate,
    candidate.replace(/\.js$/u, ".ts"),
    `${candidate}.ts`,
    join(candidate.replace(/\.js$/u, ""), "index.ts"),
  ];
  for (const t of tries) if (isFile(t)) return t;
  return null;
}

function importSpecifiers(source: string): string[] {
  const { code } = stripComments(source);
  const out: string[] = [];
  const re = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push(m[1]!);
  return out;
}

/** One hop out of `fromFile`: relative imports, and `@lares/agent-kit/<sub>` into this package's
 *  `src/`. Everything else (`eve/*`, `zod`, `googleapis`) is a third-party module we do not own
 *  and do not scan. */
function resolveImport(spec: string, fromFile: string): string | null {
  if (spec.startsWith(".")) return resolveModuleFile(resolve(dirname(fromFile), spec));
  if (spec.startsWith("@lares/agent-kit/")) {
    const sub = spec.slice("@lares/agent-kit/".length);
    // `@lares/agent-kit/tools` is the built extension barrel; the per-tool bodies are read
    // directly from `extension/tools/` by `sourcesForTool`, so there is nothing to follow here.
    if (sub === "tools" || sub === ".") return null;
    return resolveModuleFile(join(KIT_SRC, sub));
  }
  return null;
}

/** Whether a tool file is a `disableTool()` sentinel rather than a tool. eve resolves these by
 *  filename; they ship no behaviour, so there is nothing to classify and no capability to map. */
export function isDisabledSentinel(source: string): boolean {
  const { code } = stripComments(source);
  return /export\s+default\s+disableTool\s*\(\s*\)/.test(code);
}

/** The sources for one deployed tool, under the one-hop depth rule. `null` when the tool is a
 *  `disableTool()` sentinel. See this file's header for why the depth is one and why the
 *  service's thin extension re-export is not a hop. */
export function sourcesForTool(agentDir: string, tool: string): ToolSource[] | null {
  const isExtension = tool.startsWith("agent-kit__");
  const bare = isExtension ? tool.slice("agent-kit__".length) : tool;
  // A local tool lives in `agent/tools/` OR, since ORB-278 step 2 (ADR-0015 rule 3), in the
  // service's `catalogue/` pool — the same file, moved, reached through one dynamic resolver
  // instead of by filename. Looking in only one of the two would have made this lint return `[]`
  // for every moved tool and pass vacuously, which is the opposite of what it is for.
  const local = [join(agentDir, "agent", "tools", `${bare}.ts`), join(agentDir, "catalogue", `${bare}.ts`)];
  // A PREFIXED tool has the SAME two-home problem, discovered the hard way (review follow-up on
  // Task 8): its usual home is the extension MOUNT (`agent/extensions/agent-kit/tools/<bare>.ts`,
  // `resolveExtensionTool` against this agent's own agent.json) — but since Task 8 a service may
  // instead answer that prefixed key from its OWN catalogue (`catalogue/agent-kit__<bare>.ts`)
  // and turn the mount into an unconditional `disableTool()` sentinel (Marcel's
  // `agent-kit__transit_plan`; the chief-of-staff role's gated `vault_write`/`vault_drop`/`vault_file` are the next
  // ones, Task 9). Reading only the mount made `sourcesForTool` return `null` — "disabled, skip"
  // — for every prefixed tool a service moves, which is backwards: the write-shape lint matters
  // MOST on a moved GATED tool like `vault_write`, not least. Both homes can exist for the same
  // key at once (the mount stays present, disabled, once its key moves) — pick whichever one is
  // a REAL tool, matching the local branch's "look in both, an unmoved one just won't be there"
  // shape, but discriminating live-vs-sentinel explicitly since here BOTH candidates are always
  // real files once a service has made the move (a sentinel is a file, not an absence).
  const extension = [
    join(agentDir, "agent", "extensions", "agent-kit", "tools", `${bare}.ts`),
    join(agentDir, "catalogue", `agent-kit__${bare}.ts`),
  ];
  const candidates = isExtension ? extension : local;
  const isLive = (f: string): boolean => isFile(f) && !isDisabledSentinel(readFileSync(f, "utf8"));
  const entry = candidates.find(isLive) ?? candidates.find(isFile) ?? candidates[0]!;
  if (!isFile(entry)) return [];
  const entrySource = readFileSync(entry, "utf8");
  if (isDisabledSentinel(entrySource)) return null;

  const roots: ToolSource[] = [{ file: entry, source: entrySource }];
  if (isExtension) {
    // Whichever home resolved above, the entry file is a THIN RE-EXPORT, not a hop: the mount is
    // `resolveExtensionTool(manifest, cap, <kit tool>)`, and a service's own catalogue entry
    // (Task 8) is `import { X } from "@lares/agent-kit/tools"; export default X;` — same kit
    // tool, same non-hop shape. The kit body joins it at depth 0 either way, and ITS imports are
    // the one hop.
    const body = join(KIT_EXTENSION_TOOLS, `${bare}.ts`);
    if (isFile(body)) roots.push({ file: body, source: readFileSync(body, "utf8") });
  }

  const seen = new Set(roots.map((r) => r.file));
  const out = [...roots];
  for (const root of roots) {
    for (const spec of importSpecifiers(root.source)) {
      const file = resolveImport(spec, root.file);
      if (!file || seen.has(file)) continue;
      seen.add(file);
      out.push({ file, source: readFileSync(file, "utf8") });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// lintWriteShape
// ---------------------------------------------------------------------------

export type WriteShapeFindingKind = "ungated-write" | "unmapped-tool";

export interface WriteShapeFinding {
  kind: WriteShapeFindingKind;
  tool: string;
  /** The capability the tool maps to. Absent on an `unmapped-tool` finding. */
  capability?: string;
  /** The granted scope that the write-shape outranks. `"none"` when there is no grant at all. */
  scope?: Scope;
  rule?: WriteShapeRule;
  match?: string;
  file?: string;
  line?: number;
}

export interface LintWriteShapeOptions {
  /** The folder holding `agent.json`, e.g. `services/chief-of-staff`. */
  agentDir: string;
  manifest: AgentManifest;
  /** Override source resolution — for tests, and for a caller that already has the files.
   *  Return `null` to say "this name is a disabled sentinel, skip it entirely". */
  resolveSource?: (tool: string) => ToolSource[] | null;
  /** Override the deployed-tool list. Defaults to `deployedToolsFor(agentDir)`. */
  toolNames?: readonly string[];
  /** Tools to skip with a stated reason (a KNOWN finding kept out of the red). */
  skip?: Readonly<Record<string, string>>;
  classify?: ClassifyOptions;
}

/** The scope at which a write-shaped tool is legitimate. Below this, a write-shape is a finding.
 *  `write-with-confirm` and `write` both qualify (`scopeAtLeast` ranks a plain `write` higher —
 *  it runs the same action without a card). `read` and `none` do not. */
const MINIMUM_WRITE_SCOPE: Scope = "write-with-confirm";

/** Every tool whose code is write-shaped while its capability is granted below
 *  `write-with-confirm`, plus every deployed tool no capability claims.
 *
 *  A tool mapping to more than one capability (none do today) passes if ANY of them is
 *  write-class — the grant that would authorise the call is enough. */
export function lintWriteShape(opts: LintWriteShapeOptions): WriteShapeFinding[] {
  const { agentDir, manifest } = opts;
  const names = opts.toolNames ?? deployedToolsFor(agentDir);
  const resolve_ = opts.resolveSource ?? ((tool: string) => sourcesForTool(agentDir, tool));
  const findings: WriteShapeFinding[] = [];

  const frameworkTools = new Set<string>(manifest.framework_tools);

  for (const tool of names) {
    if (opts.skip && Object.hasOwn(opts.skip, tool)) continue;
    // An eve FRAMEWORK tool is not a capability tool and has no grant to check. `./manifest.ts`
    // is explicit about it: framework tools "are NOT capabilities and NOT grants: they are eve's
    // own built-ins, which `agent.json` does not govern". `services/travel/agent/tools/
    // web_search.ts` is the fleet's only live one, and it is declared in Marcel's
    // `framework_tools` — so the declaration, not a hardcoded name list, is what excuses it.
    if (frameworkTools.has(tool)) continue;
    const sources = resolve_(tool);
    if (sources === null) continue; // a disableTool() sentinel is not a tool

    const capabilities = capabilitiesForTool(tool);
    if (capabilities.length === 0) {
      findings.push({ kind: "unmapped-tool", tool });
      continue;
    }

    // A skill's tool is authorised by the capabilities the skill composes.
    const effective = capabilities.flatMap((c) =>
      c.startsWith("skill:")
        ? (manifest.skills.find((s) => s.name === c.slice("skill:".length))?.requires ?? []).map((r) => r.capability)
        : [c],
    );
    const best = effective.reduce<Scope>((acc, c) => {
      const scope = grantFor(manifest, c)?.scope ?? "none";
      return scopeAtLeast(scope, acc) ? scope : acc;
    }, "none");
    if (scopeAtLeast(best, MINIMUM_WRITE_SCOPE)) continue;

    // An ungranted or `none`-scoped capability means the tool is disabled at build time by
    // `resolveExtensionTool`; it ships no behaviour, so it is not an ungated write.
    if (best === "none") continue;

    for (const { file, source } of sources) {
      for (const m of classifyWriteShape(source, opts.classify)) {
        findings.push({
          kind: "ungated-write",
          tool,
          capability: effective.join("+"),
          scope: best,
          rule: m.rule,
          match: m.match,
          file,
          line: m.line,
        });
      }
    }
  }
  return findings;
}

/** Throws listing every finding, mirroring `assertRoleIsGeneric`. */
export function assertNoUngatedWrites(opts: LintWriteShapeOptions & { label?: string }): void {
  const findings = lintWriteShape(opts);
  if (findings.length === 0) return;
  const label = opts.label ?? opts.agentDir;
  const detail = findings
    .map((f) =>
      f.kind === "unmapped-tool"
        ? `  ${f.tool}: no capability doc lists this tool — add it to CAPABILITY_DOCS (or to a skill's tool list), or delete the tool`
        : `  ${f.tool} (${f.capability} @ ${f.scope}): ${f.rule} — ${f.match}\n      ${f.file}:${f.line}`,
    )
    .join("\n");
  throw new Error(
    `${label}: write-shaped code under a grant below "${MINIMUM_WRITE_SCOPE}" (ORB-199).\n` +
      `Either the tool must not mutate, or agent.json must declare the capability at a write ` +
      `scope. See packages/agent-kit/src/write-shape-lint.ts for what counts and what is exempt.\n${detail}`,
  );
}
