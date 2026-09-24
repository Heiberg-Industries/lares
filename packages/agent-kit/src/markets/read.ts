// The conversational read surface: answer "what's the edge on X?" from curated markets, the
// latest observed prices (de-vigged to probability), and the last edge the survey loop recorded
// per outcome. When a liveQuotes dep is supplied, marketState prefers live venue prices
// (type-aware de-vig) and falls back to the stored-snapshot path if live is unavailable or
// carries no estimates. Read-only: no writes, no survey trigger, no alerting.
//
// Copied from services/agent-runtime/lib/adapters/tyche/read-hand.ts (ORB-189 Task 1). The three
// verbs are unchanged; what did not come along is the retired runtime's hand wrapper — the
// `Capability` + `HandToolSpec` construction and the `calibration` verb, which needs the
// resolutions store that stays behind. Task 2's single `market_edge` tool is what reaches the
// model now.
import { deVig, normalizeSource } from "./probability/engine.js";
import { prob, type OutcomeId, type Probability, type SourceEstimate } from "./probability/types.js";
import type { MarketRow, SnapshotRow, AlertState } from "./types.js";
import type { QuotedMarket } from "./venue-quotes.js";

const VENUES = ["polymarket", "kalshi"] as const;
type Venue = (typeof VENUES)[number];

interface VenueQuote { ask: number; fair: number | null }

// ── cross-venue outcome alignment ────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS. Outcome ids are venue-scoped: a Polymarket outcome id is a CLOB token id
// (`polymarket-parse.ts`), a Kalshi one is a market ticker (`kalshi-parse.ts`). They are never
// equal. So keying the per-outcome quote map by the venue's own id — which is what this file did —
// meant an outcome could never carry BOTH venues, `edge.ts`'s `paired` was unreachable on real
// data, and every card said "one venue only" for markets we quote on two. `outcomeAliases` was
// read off the row and never used; it is the alignment key, and this is it being used.
//
// THE RULE, kept verbatim from the retired runtime's `lib/matching/matcher.ts` (`alignOutcomes`)
// so the two eras agree about what "the same outcome" means:
//
//   * `outcomeAliases` is `canonical LABEL → the venue spellings that mean it` — labels, not ids.
//     (`match-judge.ts`'s own prompt: "map each Polymarket outcome label to an array of spellings
//     INCLUDING the matching Kalshi spelling, e.g. {"Turkey":["Turkey","Turkiye"]}".)
//   * An outcome is filed under its label, trimmed and lower-cased, with an aliased spelling
//     folded onto its canonical label. So "Spain"/"Spain" pair with NO alias entry, and
//     "Turkiye"/"Turkey" pair only because the row says they mean the same thing. That fallback
//     is not decoration: production rows carry aliases ONLY for spelling exceptions (the seed
//     script's three: Turkey, Curacao, Bosnia and Herzegovina) and `{}` otherwise, so keying on
//     the id when a label is in no alias group would leave pairing broken for every other row.
//   * An outcome with NO label keeps its venue-scoped id as its key. It cannot be aligned, and a
//     manufactured key would pair things that are not the same outcome.
//
// AMBIGUITY IS NOT RESOLVED, IT IS DECLINED. If two outcomes ON ONE VENUE canonicalise to the
// same key, that key does not identify one outcome there, so both revert to their venue ids and
// are quoted single-venue. The retired `alignOutcomesSafe` dropped them outright; keeping them
// unaligned is the same refusal to guess without also making them disappear.

function normalizeLabel(s: string): string {
  return s.trim().toLowerCase();
}

/** normalised spelling → canonical key, including each canonical label mapped to itself. */
function aliasIndex(aliases: Record<string, string[]> | undefined): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [canonical, spellings] of Object.entries(aliases ?? {})) {
    const key = normalizeLabel(canonical);
    if (key === "") continue;
    idx.set(key, key);
    for (const spelling of spellings) {
      const from = normalizeLabel(spelling);
      if (from !== "") idx.set(from, key);
    }
  }
  return idx;
}

function canonicalOutcomeKey(label: string | null | undefined, venueOutcomeId: string, idx: Map<string, string>): string {
  const n = label ? normalizeLabel(label) : "";
  if (n === "") return venueOutcomeId;
  return idx.get(n) ?? n;
}

/** One venue's view of one outcome, before alignment. */
interface VenueOutcome { venueOutcomeId: string; label: string | null; quote: VenueQuote }

/** Both venues' outcomes folded onto canonical keys.
 *
 *  `alertOutcomeIds` are the ids to look the RECORDED edge up by, and they are deliberately the
 *  venue-scoped ones: `tyche_alert_state` was written by the retired survey loop keyed by the
 *  venue's own outcome id, so canonicalising the map key must not change what is asked of that
 *  table. BOTH are returned, Polymarket first — the survey wrote a row per (market, outcome) for
 *  EITHER venue (`market-survey/detect.ts` emits its within-market signal over polymarket AND
 *  kalshi, and `alert-state-store.record` keys the row on whichever candidate it was), so an
 *  aligned outcome can have its only recorded edge filed under the Kalshi ticker. Asking for just
 *  one id loses those rows silently, which is `bestBets` returning nothing while the edge exists.
 *
 *  The display `label` keeps the single Polymarket preference, matching the retired matcher's
 *  `label: o.label` (the Polymarket side). */
function alignOutcomes(
  aliases: Record<string, string[]> | undefined,
  byVenue: Array<[Venue, VenueOutcome[]]>,
  /** ORB-214 (2): called once per venue outcome whose label was AMBIGUOUS on its own venue and
   *  therefore left unpaired under its venue id. Safe, but it used to be invisible — nothing
   *  counted how often the alias map fell short, so its decay had no signal. */
  onDecline?: (venue: Venue, label: string | null) => void,
): Array<{
  key: string;
  label: string | null;
  alertOutcomeIds: string[];
  /** Per venue, the id and the label THAT venue published for this outcome. The aligned `key` and
   *  `label` above are ours; these are theirs, and a writer must use them — `tyche_alert_state`
   *  and `tyche_market_snapshots` are keyed by the venue's own outcome id (see `alertOutcomeIds`
   *  and `storedState`), so a row filed under the canonical key is a row nothing can read back. */
  venueOutcomes: Partial<Record<Venue, { outcomeId: string; label: string | null }>>;
  quotes: Partial<Record<Venue, VenueQuote>>;
}> {
  const idx = aliasIndex(aliases);
  const merged = new Map<string, { label: string | null; ids: Partial<Record<Venue, string>>; labels: Partial<Record<Venue, string | null>>; quotes: Partial<Record<Venue, VenueQuote>> }>();

  for (const [venue, outcomes] of byVenue) {
    // Per-venue keys first, so an ambiguous key can be detected before anything is merged.
    const keyById = new Map<string, string>();
    const uses = new Map<string, number>();
    for (const o of outcomes) {
      const key = canonicalOutcomeKey(o.label, o.venueOutcomeId, idx);
      keyById.set(o.venueOutcomeId, key);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
    for (const o of outcomes) {
      const ambiguous = (uses.get(keyById.get(o.venueOutcomeId)!) ?? 0) > 1;
      if (ambiguous) onDecline?.(venue, o.label);
      const key = ambiguous ? o.venueOutcomeId : keyById.get(o.venueOutcomeId)!;
      const slot = merged.get(key) ?? { label: null, ids: {}, labels: {}, quotes: {} };
      if (slot.label === null && o.label) slot.label = o.label;   // first venue in VENUES order wins
      if (slot.ids[venue] === undefined) {
        slot.ids[venue] = o.venueOutcomeId;
        slot.labels[venue] = o.label;   // THIS venue's spelling ("Turkiye"), not the aligned one
      }
      slot.quotes[venue] = o.quote;
      merged.set(key, slot);
    }
  }

  return [...merged].map(([key, slot]) => ({
    key,
    label: slot.label,
    venueOutcomes: Object.fromEntries(
      (Object.keys(slot.ids) as Venue[]).map((v) => [v, { outcomeId: slot.ids[v]!, label: slot.labels[v] ?? null }]),
    ) as Partial<Record<Venue, { outcomeId: string; label: string | null }>>,
    // Polymarket first (it breaks ties below); `key` is the fallback for an outcome that somehow
    // reached here with no venue id at all, so the lookup is never made with nothing.
    alertOutcomeIds: [slot.ids.polymarket, slot.ids.kalshi].filter((id): id is string => !!id).length > 0
      ? [slot.ids.polymarket, slot.ids.kalshi].filter((id): id is string => !!id)
      : [key],
    quotes: slot.quotes,
  }));
}

function latestInstant(rows: SnapshotRow[]): Map<OutcomeId, number> {
  const byOutcome = new Map<OutcomeId, number>();
  if (rows.length === 0) return byOutcome;
  const newestTs = rows[0].tsIso; // store returns newest-first
  for (const r of rows) {
    if (r.tsIso !== newestTs) break;
    if (r.ask != null) byOutcome.set(r.outcomeId, r.ask);
  }
  return byOutcome;
}

function fairOf(asks: Map<OutcomeId, number>, mutuallyExclusive: boolean): Map<OutcomeId, number | null> {
  const out = new Map<OutcomeId, number | null>();
  if (!mutuallyExclusive) {
    for (const [k, v] of asks) out.set(k, v); // raw ask IS the prob for independent markets
    return out;
  }
  if (asks.size < 2) {
    for (const k of asks.keys()) out.set(k, null); // degenerate book → no honest de-vig
    return out;
  }
  const raw: Record<OutcomeId, Probability> = {};
  for (const [k, v] of asks) raw[k] = prob(v);
  const { fair } = deVig(raw);
  for (const k of asks.keys()) out.set(k, fair[k] ?? null);
  return out;
}

// Live per-venue quotes: independent book → fair == raw ask (normalizeSource passes it through);
// mutually-exclusive with ≥2 priced outcomes → de-vigged; mutually-exclusive with <2 → fair null
// (never fabricate a 1.0). Mirrors the stored-path honesty guard but uses the live market type.
function liveVenueQuotes(estimate: SourceEstimate | null): Map<OutcomeId, VenueQuote> {
  const out = new Map<OutcomeId, VenueQuote>();
  if (!estimate) return out;
  const me = (estimate.meta as { mutuallyExclusive?: boolean } | undefined)?.mutuallyExclusive ?? true;
  const ids = Object.keys(estimate.raw);
  const norm = (me && ids.length < 2) ? null : normalizeSource(estimate);
  for (const id of ids) {
    out.set(id, { ask: estimate.raw[id] as number, fair: norm ? (norm.fair[id] as number) : null });
  }
  return out;
}

/** One entry of the bestBets ranking: the RECORDED edge, plus the last stored quote the same
 *  read already had in hand.
 *
 *  The quote fields (`venue`, `ask`, `fair`, `quotedAtIso`) exist because a card has to say WHAT
 *  is priced and at what, and `tyche_alert_state` holds neither — it holds an edge and a basis
 *  whose meaning depends on which signal family wrote the row, and the row does not record which
 *  (`services/agent-runtime/lib/workflows/market-survey/detect.ts`: a cross-market basis is the
 *  other venue's probability, a momentum basis is the same outcome's earlier probability). So a
 *  fair or an ask cannot be recovered from the pair without inventing one. They come from the
 *  stored snapshot `storedState` read a few lines above instead: no extra query, no live fetch,
 *  and every number on the eventual card is one a venue actually quoted (ORB-189 Task 2).
 *
 *  `outcomeId` is the CANONICAL key (see {@link alignOutcomes}), not a venue's own id: a labelled
 *  outcome is filed under its alias-folded label so both venues' quotes land together, and only an
 *  unlabelled one keeps its venue-scoped id. The recorded edge is still looked up by the venue id
 *  the survey wrote, which is why the two are kept apart.
 *
 *  `venue` stays single because a snapshot row is venue-scoped: even on an aligned outcome, one
 *  stored quote comes from one venue. Both-priced is handled rather than assumed away, preferring
 *  Polymarket, which is the subject venue of every cross-market signal. */
export interface RankedEntry {
  marketId: string;
  marketLabel: string;
  outcomeId: string;
  outcomeLabel: string | null;
  lastEdge: number;
  lastBasis: number | null;
  lastAlertedAtIso: string | null;
  recordedAtIso: string | null;
  referenced: boolean;
  venue: "polymarket" | "kalshi" | null;
  ask: number | null;
  fair: number | null;
  quotedAtIso: string | null;
}

// ── findMarkets token search ─────────────────────────────────────────────────
//
// WHY TOKENS, NOT THE WHOLE PHRASE (ORB-189 acceptance). The old test was
// `(label+id).includes(wholeLowercasedQuery)` — correct only when the caller's words appear in
// that exact order with no extra words. Saga does not do that: she asks with the outcome's own
// words ("Brazil election") or a longer paraphrase ("Brazil presidential election first round
// second place"), and neither is a literal substring of the row actually on the watchlist
// ("Brazil Presidential Election First Round: 2nd Place", id
// `wc26-brazil-presidential-election-first-round-2nd-place`) — both calls came back `{cards: []}`,
// which Saga read as "not on the watchlist" for a market that was. Token matching asks the weaker,
// correct question instead: does the row's text contain EVERY word the caller used, in any order,
// anywhere across label or id (so an id fragment like "wc26-brazil" still finds it through the id
// when the label alone would not, and "fed" finds "Fed Decision in September?"). A single-token
// query degenerates to the old substring test modulo punctuation, so that case is unchanged.
//
// Punctuation is noise, not a caller-meaningful token boundary (the ":" after "Round" above), so
// it is folded to whitespace on both sides before splitting — never treated as a search term.
//
// ORB-214 (9): a spelled-out ordinal is folded to its digit form on BOTH sides of the match —
// "second" and "2nd" share no substring, so a query in the word form missed a label carrying
// only the digit form (the ORB-189 acceptance round hit exactly this). Ten ordinals, nothing
// cleverer: this is the shape a market name actually takes ("2nd place", "1st round").
const ORDINAL_WORDS: Readonly<Record<string, string>> = {
  first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th",
  sixth: "6th", seventh: "7th", eighth: "8th", ninth: "9th", tenth: "10th",
};
const ORDINAL_WORD_RE = new RegExp(`\\b(${Object.keys(ORDINAL_WORDS).join("|")})\\b`, "g");

function normalizeSearchText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(ORDINAL_WORD_RE, (w) => ORDINAL_WORDS[w] ?? w)
    .trim();
}

function tokenizeQuery(query: string): string[] {
  const n = normalizeSearchText(query);
  return n === "" ? [] : n.split(" ");
}

/** ORB-214 (3) — how many stored snapshot rows one (market, venue) read pulls for the stored
 *  path. Was 40, which truncated any venue with more than 40 outcomes at its newest instant
 *  (world-cup-winner carried 60), so the stored-path de-vig ran over a PARTIAL book and the
 *  card had to say so. 200 covers a 60-outcome book at its newest instant with room for the
 *  two instants before it. The card caveat names this constant, not a number. */
export const STORED_BOOK_WINDOW = 200;

/** ORB-214 (3) — the most open markets one `bestBets` call will read stored state for. Each
 *  costs a handful of serial DB round trips, and the verb used to walk every row on the
 *  watchlist. The bound needs a KNOWN ordering (an unordered slice silently drops the valuable
 *  half): open markets are scanned soonest-closing first, because an edge on a market that
 *  closes next week is worth more attention than one that closes next year, and the result
 *  says how many it covered. */
export const BEST_BETS_SCAN_MAX = 60;

export function makeMarketsRead(deps: {
  markets: { listMarkets(): Promise<MarketRow[]> };
  snapshots: { recentByMarketVenue(a: { marketId: string; venue: string; limit: number }): Promise<SnapshotRow[]> };
  alertState: { get(a: { marketId: string; outcomeId: string }): Promise<AlertState | null> };
  liveQuotes?: { get(row: MarketRow): Promise<QuotedMarket> };   // optional live fetch
  /** Injectable clock (tests) — decides whether a market's end date has passed. */
  now?: () => Date;
}) {
  const nowMs = (): number => (deps.now ? deps.now() : new Date()).getTime();
  /** ORB-214 (6) — the calendar day a market closed on, or null while it is open. A settled
   *  market's venues serve settlement markers (1.00 / 0.00) that the placeholder guard rightly
   *  refuses, so without this the read path answered "no quotes" for a market that had simply
   *  finished — honest, but the real answer is "settled, and here is who won". */
  const settledOn = (m: MarketRow): string | null => {
    if (!m.endDateIso) return null;
    const t = Date.parse(m.endDateIso);
    return Number.isFinite(t) && t < nowMs() ? m.endDateIso.slice(0, 10) : null;
  };
  /** The venue's own settlement marker off the NEWEST stored book: every outcome priced at
   *  ≥ 0.99. Read off the marker, never off a resolution feed — the `calibration` verb stayed
   *  with the retired runtime, and a marker is what the venue actually published. */
  async function settlementMarkers(m: MarketRow): Promise<string[]> {
    const winners: string[] = [];
    for (const venue of ["polymarket", "kalshi"] as const) {
      let rows: SnapshotRow[];
      try {
        rows = await deps.snapshots.recentByMarketVenue({ marketId: m.id, venue, limit: 80 });
      } catch {
        continue;
      }
      if (rows.length === 0) continue;
      const newest = rows.reduce((acc, row) => (row.tsIso > acc ? row.tsIso : acc), rows[0]!.tsIso);
      for (const row of rows) {
        if (row.tsIso === newest && row.ask !== null && row.ask >= 0.99) {
          winners.push(`"${row.label ?? row.outcomeId}" at ${row.ask.toFixed(2)} (${venue})`);
        }
      }
    }
    return winners;
  }
  /** The recorded edge for an aligned outcome, found under EITHER venue's id.
   *
   *  WHICH ROW WINS WHEN BOTH EXIST: the one with the newer `recordedAtIso` (the row's
   *  `updated_at`), and Polymarket on a tie or when neither carries a timestamp. Not "Polymarket
   *  always", because the number this returns is the one `bestBets` RANKS on and the one the card
   *  prints beside "recorded <date>": ranking on a stale Polymarket row while a fresher Kalshi
   *  measurement of the same outcome sits unread would be a worse answer that still looked
   *  correct. Polymarket breaking the tie keeps the old behaviour where the two are equally
   *  fresh — it is the subject venue of every cross-market signal.
   *
   *  COST: one extra indexed PK read per outcome that actually aligned (unaligned outcomes carry
   *  a single id and make a single call, exactly as before). */
  async function recordedEdge(marketId: string, outcomeIds: string[]): Promise<AlertState | null> {
    let best: AlertState | null = null;
    for (const outcomeId of outcomeIds) {
      const row = await deps.alertState.get({ marketId, outcomeId });
      if (!row) continue;
      if (!best) { best = row; continue; }
      // Strictly newer only, so the first id in the list (Polymarket) survives a tie.
      if ((row.recordedAtIso ?? "") > (best.recordedAtIso ?? "")) best = row;
    }
    return best;
  }

  async function resolveMarket(idOrLabel: string): Promise<MarketRow | null> {
    const all = await deps.markets.listMarkets();
    const needle = idOrLabel.trim().toLowerCase();
    if (!needle) return null;
    const exact = all.find((m) => m.id.toLowerCase() === needle || m.label.toLowerCase() === needle);
    if (exact) return exact;
    const subs = all.filter((m) => m.label.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle));
    return subs.length === 1 ? subs[0] : null; // unique substring only; ambiguous → null (use findMarkets)
  }

  /** ORB-214 (2): one counter per state read. Logged once per market when non-zero so the
   *  alias map's decay is visible in the container log without anyone re-deriving it. */
  const declineCounter = (marketId: string) => {
    let n = 0;
    const seen: string[] = [];
    return {
      note: (venue: Venue, label: string | null) => {
        n += 1;
        seen.push(`${label ?? "(no label)"} on ${venue}`);
      },
      finish: (): number => {
        if (n > 0) console.warn(`markets: ${n} outcome(s) on ${marketId} share a label and were left unpaired — ${seen.join(", ")}; add an outcome_aliases entry to pair them`);
        return n;
      },
    };
  };

  async function storedState(m: MarketRow) {
    const declined = declineCounter(m.id);
    const byVenue: Array<[Venue, VenueOutcome[]]> = [];
    let newestTsIso: string | null = null;
    for (const venue of VENUES) {
      const rows = await deps.snapshots.recentByMarketVenue({ marketId: m.id, venue, limit: STORED_BOOK_WINDOW });
      const newestTs = rows[0]?.tsIso;
      if (newestTs && (!newestTsIso || newestTs > newestTsIso)) newestTsIso = newestTs;
      const labelByOutcome = new Map<OutcomeId, string>(); // human name ("Spain"), for read-back
      for (const r of rows) {
        if (r.tsIso !== newestTs) break;            // only the newest instant
        if (r.label && !labelByOutcome.has(r.outcomeId)) labelByOutcome.set(r.outcomeId, r.label);
      }
      const asks = latestInstant(rows);
      const fair = fairOf(asks, m.marketType === "mutually_exclusive");
      byVenue.push([
        venue,
        [...asks].map(([outcomeId, ask]) => ({
          venueOutcomeId: outcomeId,
          label: labelByOutcome.get(outcomeId) ?? null,
          quote: { ask, fair: fair.get(outcomeId) ?? null },
        })),
      ]);
    }

    const outcomes = [];
    for (const a of alignOutcomes(m.outcomeAliases, byVenue, declined.note)) {
      const st = await recordedEdge(m.id, a.alertOutcomeIds);
      outcomes.push({
        outcomeId: a.key,
        label: a.label,
        // The venue's OWN id and spelling per venue, for anything that WRITES a row keyed the way
        // these two tables are keyed (ORB-214 item 1's refresh job). Readers want `outcomeId`.
        venueOutcomes: a.venueOutcomes,
        polymarket: a.quotes.polymarket ?? null,
        kalshi: a.quotes.kalshi ?? null,
        lastEdge: st?.lastEdge ?? null,
        lastBasis: st?.lastBasis ?? null,
        lastAlertedAtIso: st?.lastAlertedAtIso ?? null,
        recordedAtIso: st?.recordedAtIso ?? null,
      });
    }
    return {
      ok: true as const,
      source: "stored" as const,
      declinedAlignments: declined.finish(),
      asOfIso: newestTsIso,
      kalshiUnavailable: null,
      market: { id: m.id, label: m.label, endDateIso: m.endDateIso },
      outcomes,
    };
  }

  async function liveState(m: MarketRow, q: QuotedMarket) {
    const declined = declineCounter(m.id);
    const venues: Array<[Venue, SourceEstimate | null, { outcomes: { outcomeId: string; label: string }[] } | null]> = [
      ["polymarket", q.pmEstimate, q.pmSpec],
      ["kalshi", q.kalshiEstimate, q.kalshiSpec],
    ];
    const byVenue: Array<[Venue, VenueOutcome[]]> = venues.map(([venue, estimate, spec]) => {
      const labelByOutcome = new Map<OutcomeId, string>();
      if (spec) for (const o of spec.outcomes) if (!labelByOutcome.has(o.outcomeId)) labelByOutcome.set(o.outcomeId, o.label);
      return [
        venue,
        [...liveVenueQuotes(estimate)].map(([outcomeId, quote]) => ({
          venueOutcomeId: outcomeId,
          label: labelByOutcome.get(outcomeId) ?? null,
          quote,
        })),
      ] as [Venue, VenueOutcome[]];
    });

    const outcomes = [];
    for (const a of alignOutcomes(m.outcomeAliases, byVenue, declined.note)) {
      const st = await recordedEdge(m.id, a.alertOutcomeIds);
      outcomes.push({
        outcomeId: a.key,
        label: a.label,
        // The venue's OWN id and spelling per venue, for anything that WRITES a row keyed the way
        // these two tables are keyed (ORB-214 item 1's refresh job). Readers want `outcomeId`.
        venueOutcomes: a.venueOutcomes,
        polymarket: a.quotes.polymarket ?? null,
        kalshi: a.quotes.kalshi ?? null,
        lastEdge: st?.lastEdge ?? null,
        lastBasis: st?.lastBasis ?? null,
        lastAlertedAtIso: st?.lastAlertedAtIso ?? null,
        recordedAtIso: st?.recordedAtIso ?? null,
      });
    }
    return { ok: true as const, source: "live" as const, asOfIso: null, declinedAlignments: declined.finish(),
      // Carried from the quote so a card can say WHY the Kalshi side is missing instead of
      // claiming this is a one-venue market.
      kalshiUnavailable: q.kalshiUnavailable ?? null,
      market: { id: m.id, label: m.label, endDateIso: m.endDateIso }, outcomes };
  }

  /** The reason for a market that IS on the watchlist and has NOTHING to quote — the one case
   *  this function used to answer `ok: true` with an EMPTY `outcomes` array. `edge.ts` renders
   *  that as a bare `{cards: []}`, which is the shape reserved for "the watchlist was read and
   *  holds nothing matching", so the model read a curated row as absent from the watchlist: a
   *  false statement about our own coverage, and exactly the confusion `edge.ts`'s "absent ≠
   *  empty" rule exists to prevent. Now it is an `ok: false` reason, which `state` returns as
   *  `unavailable` and `find` folds into `could not read: …`.
   *
   *  MEASURED, not imagined (`wc26-winner`, both venues, live, 2026-09-03): the 2026 World Cup
   *  settled on 2026-07-19, so Gamma serves Spain at 1.00 and the other 59 teams at 0.00, and all
   *  31 Kalshi markets are `status: "finalized"` at ask 1.0000 / bid 0.0000. `isPlaceholderQuote`
   *  refuses every one of them — correctly: a settlement marker is not a price, and a stuck 1.00
   *  fed into de-vig crushes every other outcome's fair. Both producers therefore returned a
   *  SourceEstimate with an empty `raw`, both estimates were non-null, and the live path answered
   *  `ok: true, source: "live", outcomes: []`.
   *
   *  A settled market is not the only way to arrive here (a venue can serve an entirely unpriced
   *  book too), and none of the ways is an answer — so they all take the same route below. */
  const NO_QUOTES_REASON = "no quotes — the venues returned no outcomes and there are no stored snapshots";

  async function marketState(idOrLabel: string) {
    const m = await resolveMarket(idOrLabel);
    // Self-contained, because there are now TWO kinds of `ok: false` and the caller cannot tell
    // them apart: "not on the watchlist" is only true of this one, so only this one says it.
    if (!m) return { ok: false as const, reason: `no curated market matching "${idOrLabel}" — nothing on the watchlist to quote` };
    const closed = settledOn(m);
    if (closed) {
      // Never the live path for a closed market: there is no book, only markers.
      const markers = await settlementMarkers(m);
      const marker = markers.length > 0
        ? ` — the venue's settlement marker prices ${markers.join(" and ")}, i.e. that outcome resolved YES; read off the marker, not a resolution feed`
        : "";
      return {
        ok: false as const,
        reason: `settled — this market closed on ${closed}; there is no live book to quote and any recorded edge is history${marker}`,
      };
    }
    if (deps.liveQuotes) {
      try {
        const q = await deps.liveQuotes.get(m);
        if (q && (q.pmEstimate || q.kalshiEstimate)) {
          const live = await liveState(m, q);
          // A live quote of NOTHING is a failure of the live path, not a quote. Same treatment as
          // a throw: fall through to the stored snapshots, which may well still hold a real book.
          if (live.outcomes.length > 0) return live;
          console.warn(`markets: live quote for ${m.id} priced no outcome; falling back to stored`);
        }
      } catch (e) {
        console.warn(`markets: live quote failed for ${m.id}; falling back to stored`, e);
      }
    }
    const stored = await storedState(m);
    if (stored.outcomes.length > 0) return stored;
    return { ok: false as const, reason: NO_QUOTES_REASON };
  }

  const EDGE_BASIS_EPS = 0.02;
  const BEST_BETS_MAX = 12;

  async function findMarkets(query: string): Promise<{
    matches: Array<{ id: string; label: string; hasKalshi: boolean; settled: boolean; settledOn?: string }>;
  }> {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return { matches: [] };
    const all = await deps.markets.listMarkets();
    const matches = all
      .filter((m) => {
        const haystack = normalizeSearchText(`${m.label} ${m.id}`);
        return tokens.every((t) => haystack.includes(t));
      })
      .map((m) => {
        const closed = settledOn(m);
        return {
          id: m.id,
          label: m.label,
          hasKalshi: !!(m.kalshiEventTicker && m.kalshiEventTicker.trim()),
          settled: closed !== null,
          ...(closed ? { settledOn: closed } : {}),
        };
      });
    return { matches };
  }

  // bestBets: collect all outcomes with a recorded lastEdge across all markets, then:
  //   1. Drop artifact entries where edge ≈ basis (|lastEdge - lastBasis| < EPS). Null basis = keep.
  //   2. Tag each entry as referenced (has a non-empty kalshiEventTicker).
  //   3. Sort: referenced first, then by |lastEdge| descending within each group.
  //   4. Cap at BEST_BETS_MAX entries.
  // Always uses stored snapshots — never the live-quote path — so a wide curated set does NOT fan
  // out to hundreds of serial live fetches.
  // Each entry carries recordedAtIso — when the edge was RECORDED, not re-quoted — so a card built
  // from it can say so out loud (ORB-189 Task 2).
  // ORB-214 (4): the optional `emitCard` dependency and the ranked-feed formatter are GONE — no
  // post originates in this package, as a property of the code rather than of a call site.
  async function bestBets(): Promise<{ ranked: RankedEntry[]; scanned: number; open: number }> {
    const all = await deps.markets.listMarkets();
    // ORB-214 (6): a settled market cannot be bet — its recorded edge is history, not a ranking.
    const open = all.filter((m) => settledOn(m) === null);
    // ORB-214 (3): soonest-closing first, then by id for a stable order; markets with no end
    // date sort last (nothing says when they resolve). Then the bound.
    const endMs = (m: MarketRow): number => (m.endDateIso ? Date.parse(m.endDateIso) : Number.POSITIVE_INFINITY);
    const scan = [...open].sort((a, b) => endMs(a) - endMs(b) || a.id.localeCompare(b.id)).slice(0, BEST_BETS_SCAN_MAX);
    const entries: RankedEntry[] = [];
    for (const m of scan) {
      const state = await storedState(m); // always stored: bestBets must not trigger a live-fetch storm
      if (!state.ok) continue;
      const referenced = !!(m.kalshiEventTicker && m.kalshiEventTicker.trim().length > 0);
      for (const o of state.outcomes) {
        if (o.lastEdge == null) continue;
        // Drop artifact: entry where lastEdge ≈ lastBasis (within EDGE_BASIS_EPS). Null basis = not artifact.
        if (o.lastBasis != null && Math.abs(Math.abs(o.lastEdge) - o.lastBasis) < EDGE_BASIS_EPS) continue;
        // The stored quote, from the state already computed above — never a second read, and
        // never a number the snapshot did not carry.
        const quote = o.polymarket ?? o.kalshi;
        const venue = o.polymarket ? ("polymarket" as const) : o.kalshi ? ("kalshi" as const) : null;
        entries.push({
          marketId: m.id,
          marketLabel: m.label,
          outcomeId: o.outcomeId,
          outcomeLabel: o.label,
          lastEdge: o.lastEdge,
          lastBasis: o.lastBasis,
          lastAlertedAtIso: o.lastAlertedAtIso,
          recordedAtIso: o.recordedAtIso,
          referenced,
          venue,
          ask: quote ? quote.ask : null,
          fair: quote ? quote.fair : null,
          quotedAtIso: state.asOfIso,
        });
      }
    }

    // Sort: referenced first, then by |lastEdge| descending within each group
    entries.sort((a, b) => {
      if (a.referenced !== b.referenced) return a.referenced ? -1 : 1;
      return Math.abs(b.lastEdge) - Math.abs(a.lastEdge);
    });

    // Cap
    const ranked = entries.slice(0, BEST_BETS_MAX);
    return { ranked, scanned: scan.length, open: open.length };
  }

  return { findMarkets, marketState, bestBets };
}
