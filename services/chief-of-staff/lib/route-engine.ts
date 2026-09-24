/**
 * lib/route-engine.ts — routing engine: scan → group → classify → dedup → proposals.
 *
 * `makeRouteEngine({ twenty, classifier, store, clock?, selfHandles? }).scan()` →
 * `Promise<RouteProposal[]>`
 *
 * This is the orchestration core for CRM routing. It:
 *   1. Reads the last-seen cursor from the store (defaults to 24h ago on first run).
 *   2. Pulls recent message + calendar participants from Twenty.
 *   3. Filters out self-handles and null-personId participants; groups the rest by personId.
 *   4. For each person (sorted for determinism): fetches activity content, classifies, dedups
 *      against already-proposed signals, and applies the mode policy.
 *   5. Advances the cursor to the max createdAt seen before returning.
 *
 * All deps are injected → fully offline-testable (no live Twenty / DB / LLM in tests).
 *
 * NOTE: the engine does NOT call store.recordProposal — the schedule records after it sends,
 * which keeps the engine pure and idempotent. The engine only READS alreadyProposed + advances
 * the cursor.
 *
 * NOTE on graduation seam: v1 only emits "confirm" (confidence >= LOW_CONFIDENCE) or "skip".
 * Future: add an AUTO_CONFIDENCE threshold so high-confidence proposals return "auto" and the
 * schedule executes them directly without a 👍. One constant + one schedule branch; no engine
 * rewrite.
 *
 * Ported verbatim from `services/agent-runtime/lib/adapters/route/engine.ts`.
 */

import type { RouteBrand, RouteStage, RouteDecision, RouteActivity, OpenOpportunity } from "./route-classify.js";
import { VALID_STAGES } from "./route-classify.js";

// ─── Policy constants ─────────────────────────────────────────────────────────

/** Minimum confidence to surface a proposal. Below this → held (not emitted). */
export const LOW_CONFIDENCE = 0.5;

/**
 * Decide the proposal mode from the classifier confidence.
 *
 * v1: below LOW_CONFIDENCE → "skip" (held, not emitted to the schedule).
 *     Otherwise → "confirm" (requires 👍 before any write).
 *
 * Graduation: add a HIGH_CONFIDENCE constant here; confidence >= HIGH_CONFIDENCE → "auto"
 * (the schedule executes the capability directly and appends a daily audit summary).
 */
export function decideProposalMode(confidence: number): "confirm" | "auto" | "skip" {
  if (confidence < LOW_CONFIDENCE) return "skip";
  return "confirm";
  // Future:
  // if (confidence >= HIGH_CONFIDENCE) return "auto";
  // return "confirm";
}

// ─── RouteProposal ────────────────────────────────────────────────────────────

export interface RouteProposal {
  personId: string;
  opportunityId: string | null;
  brand: RouteBrand;
  stage: RouteStage;
  action: "move" | "create";
  confidence: number;
  reasoning: string;
  signalRef: string;
  mode: "confirm" | "auto";
  /** Handle of the newest signal participant — used for human-readable proposal names/summaries. */
  personHandle: string;
  /** The person's real name from Twenty, falling back to `personHandle` when Twenty has none —
   *  used for opportunity names ("ORAKEL — Jonas Markussen", not "ORAKEL — jonas@..."). */
  personName: string;
}

// ─── Structural dep types (only the methods used — keeps the engine testable) ─

interface TwentyDep {
  listRecentMessageParticipants(sinceIso: string): Promise<Array<{
    personId: string | null;
    messageId: string;
    handle: string;
    role: string;
    createdAt: string;
  }>>;
  listRecentCalendarParticipants(sinceIso: string): Promise<Array<{
    personId: string | null;
    calendarEventId: string;
    handle: string;
    isOrganizer: boolean;
    createdAt: string;
  }>>;
  getMessage(id: string): Promise<{ subject: string; text: string; receivedAt: string }>;
  getCalendarEvent(id: string): Promise<{ title: string; description: string; startsAt: string }>;
  listOpportunitiesForPerson(personId: string): Promise<Array<{ id: string; name: string; stage: string; brand: string }>>;
  getPersonName(personId: string): Promise<string | null>;
}

interface ClassifierDep {
  classify(input: { activity: RouteActivity[]; openOpportunities: OpenOpportunity[] }): Promise<RouteDecision>;
}

interface StoreDep {
  getCursor(): Promise<string | null>;
  setCursor(iso: string): Promise<void>;
  alreadyProposed(args: { personId: string; signalRef: string }): Promise<boolean>;
  /** Any proposal for this person AND brand since `sinceIso` — the cool-down's memory. */
  proposedSince(args: { personId: string; brand: string; sinceIso: string }): Promise<boolean>;
}

// ─── Discriminated participant union ──────────────────────────────────────────

type MsgParticipant = {
  kind: "email";
  personId: string;
  messageId: string;
  handle: string;
  createdAt: string;
};

type CalParticipant = {
  kind: "meeting";
  personId: string;
  calendarEventId: string;
  handle: string;
  createdAt: string;
};

type Participant = MsgParticipant | CalParticipant;

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * One proposal per person and brand per fourteen days. Every daily digest email is a NEW
 * message id, so the per-(person, signal) dedup alone let the same person re-surface every
 * morning (Kai: 09-05, 09-06, 09-07). A card Bendik cancels leaves no trace the engine can
 * read (the HITL decline never reaches the store), so the cool-down runs from the PROPOSAL,
 * not from the decision — the only event the engine itself records.
 */
export const PROPOSAL_COOLDOWN_DAYS = 14;

function domainOf(handle: string): string {
  const at = handle.lastIndexOf("@");
  return at === -1 ? "" : handle.slice(at + 1).toLowerCase();
}

export function makeRouteEngine(deps: {
  twenty: TwentyDep;
  classifier: ClassifierDep;
  store: StoreDep;
  clock?: () => Date;
  selfHandles?: string[];
  /** The org's own email domains (orgs.domains) — colleagues and the org's own product
   *  senders are never prospects. Per-install data; empty = no exclusion, as before. */
  internalDomains?: string[];
}) {
  const { twenty, classifier, store } = deps;
  const clock = deps.clock ?? (() => new Date());
  const selfHandlesLower = new Set((deps.selfHandles ?? []).map((h) => h.toLowerCase()));
  const internalDomains = new Set((deps.internalDomains ?? []).map((d) => d.trim().toLowerCase()).filter((d) => d !== ""));

  return {
    async scan(): Promise<RouteProposal[]> {
      // 1. Determine the scan window start
      const storedCursor = await store.getCursor();
      const since: string = storedCursor ?? (() => {
        const d = new Date(clock().getTime() - 24 * 60 * 60 * 1000);
        return d.toISOString();
      })();

      // 2. Pull recent participants from both channels
      const [rawMsg, rawCal] = await Promise.all([
        twenty.listRecentMessageParticipants(since),
        twenty.listRecentCalendarParticipants(since),
      ]);

      // Build unified list, tracking max createdAt across all pulled participants
      let maxCreatedAt: string | null = null;

      function trackMax(iso: string) {
        if (!maxCreatedAt || iso > maxCreatedAt) maxCreatedAt = iso;
      }

      const participants: Participant[] = [];

      let skippedInternal = 0;

      for (const p of rawMsg) {
        trackMax(p.createdAt);
        if (p.personId === null) continue;
        if (selfHandlesLower.has(p.handle.toLowerCase())) continue;
        if (internalDomains.has(domainOf(p.handle))) { skippedInternal += 1; continue; }
        participants.push({
          kind: "email",
          personId: p.personId,
          messageId: p.messageId,
          handle: p.handle,
          createdAt: p.createdAt,
        });
      }

      for (const p of rawCal) {
        trackMax(p.createdAt);
        if (p.personId === null) continue;
        if (selfHandlesLower.has(p.handle.toLowerCase())) continue;
        if (internalDomains.has(domainOf(p.handle))) { skippedInternal += 1; continue; }
        participants.push({
          kind: "meeting",
          personId: p.personId,
          calendarEventId: p.calendarEventId,
          handle: p.handle,
          createdAt: p.createdAt,
        });
      }

      // 3. Group remaining participants by personId
      if (skippedInternal > 0) {
        console.info(`crm-routing: skipped ${skippedInternal} participant(s) on the org's own domains`);
      }

      const byPerson = new Map<string, Participant[]>();
      for (const p of participants) {
        const group = byPerson.get(p.personId);
        if (group) {
          group.push(p);
        } else {
          byPerson.set(p.personId, [p]);
        }
      }

      // 4. Process each person deterministically (sorted personIds for stable order)
      const personIds = [...byPerson.keys()].sort();
      const proposals: RouteProposal[] = [];

      for (const personId of personIds) {
        const group = byPerson.get(personId)!;

        // a. Build activity array from this person's participants
        const activity: RouteActivity[] = [];

        for (const p of group) {
          if (p.kind === "email") {
            const msg = await twenty.getMessage(p.messageId);
            activity.push({
              personHandle: p.handle,
              kind: "email",
              subject: msg.subject,
              body: msg.text.slice(0, 2000),
              at: msg.receivedAt,
            });
          } else {
            const evt = await twenty.getCalendarEvent(p.calendarEventId);
            activity.push({
              personHandle: p.handle,
              kind: "meeting",
              subject: evt.title,
              body: (evt.description || "").slice(0, 2000),
              at: evt.startsAt,
            });
          }
        }

        // b. Fetch open opportunities
        const openOpportunities: OpenOpportunity[] = await twenty.listOpportunitiesForPerson(personId);

        // c. Classify
        const decision: RouteDecision = await classifier.classify({ activity, openOpportunities });

        // Skip if classifier says do nothing, or didn't resolve brand/stage
        if (decision.action === "none" || decision.brand === null || decision.stage === null) {
          continue;
        }

        // d. Determine signalRef — newest participant for this person (max createdAt)
        let newestParticipant: Participant = group[0]!;
        for (const p of group) {
          if (p.createdAt > newestParticipant.createdAt) newestParticipant = p;
        }
        const signalRef = newestParticipant.kind === "email"
          ? `msg:${newestParticipant.messageId}`
          : `cal:${newestParticipant.calendarEventId}`;

        // e. Dedup check
        if (await store.alreadyProposed({ personId, signalRef })) {
          continue;
        }

        // f. Reconcile the classifier's action against the ACTUAL open-opportunity list —
        // the code, not the LLM, decides create-vs-move. A matching open opp for the brand
        // always means "move" (duplicate guard: a hallucinated "create" would otherwise put
        // a second card in the pipeline); no matching opp always means "create".
        const cooldownSince = new Date(clock().getTime() - PROPOSAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
        if (await store.proposedSince({ personId, brand: decision.brand, sinceIso: cooldownSince })) {
          continue;
        }

        const matchingOpp = openOpportunities.find((o) => o.brand === decision.brand);
        const action: "move" | "create" = matchingOpp ? "move" : "create";
        const opportunityId: string | null = matchingOpp?.id ?? null;

        // A move is only ever forward. The classifier sees the open opportunity but reasons
        // from the activity ("a reply on the thread") and can name an EARLIER stage; applying
        // that would quietly lose the qualification (Finago, 2026-09-07: QUALIFIED → CONTACTED).
        if (matchingOpp) {
          const current = (VALID_STAGES as readonly string[]).indexOf(matchingOpp.stage);
          const proposed = (VALID_STAGES as readonly string[]).indexOf(decision.stage);
          if (current >= 0 && proposed <= current) continue;
        }

        // g. Apply mode policy
        const mode = decideProposalMode(decision.confidence);
        if (mode === "skip") {
          continue;
        }

        // h. Resolve the person's display name — only for proposals that actually emit,
        // so held/deduped signals never cost the extra Twenty read.
        const personName = (await twenty.getPersonName(personId)) ?? newestParticipant.handle;

        proposals.push({
          personId,
          opportunityId,
          brand: decision.brand,
          stage: decision.stage,
          action,
          confidence: decision.confidence,
          reasoning: decision.reasoning,
          signalRef,
          mode,
          personHandle: newestParticipant.handle,
          personName,
        });
      }

      // 5. Advance the cursor — always, even when no proposals were emitted. Deliberate
      // ordering: cursor advances here in scan() BEFORE the schedule records proposals, so a
      // crash mid-tick drops a proposal rather than risking a re-nag (prefer-drop-over-double-nag).
      await store.setCursor(maxCreatedAt ?? clock().toISOString());

      return proposals;
    },
  };
}
