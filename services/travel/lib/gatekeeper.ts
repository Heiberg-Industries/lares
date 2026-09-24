// lib/gatekeeper.ts — keeps Marcel quiet in a linked trip's group chat.
//
// Ported from services/marcel/lib/gatekeeper.ts with one deliberate change: `tz` moves from
// a constructor dependency to a per-call `consider()` argument. Old Marcel was single-trip
// and hardcoded "Europe/Paris"; eve-marcel's Telegram channel can gate several linked trips
// at once, each with its own timezone (a `TripStore` field, Task 5/9), so quiet hours must
// be evaluated in whichever trip's tz the calling chat resolves to — that lookup is the
// channel's job (`agent/channels/telegram.ts`), not this file's.
//
// Rules are enforced IN CODE regardless of what the injected `decide` model says: quiet
// hours always silence; consecutive speaks and a rolling-hour cap downgrade a model "speak"
// to a "react"; anything malformed or erroring from the model fails silent. No persistence —
// an in-memory per-chat Map is fine, a restart resetting caps is acceptable.
import { generateText, type LanguageModel } from "ai";
import type { Budget } from "./budget.js";

export type GateAction = { action: "silent" } | { action: "react"; emoji: string } | { action: "speak" };

export interface GatekeeperDeps {
  decide(transcript: string): Promise<GateAction>; // the raw model call, injected — see makeGateDecide()
  now(): number; // unix seconds
}

interface ChatState {
  speakTimes: number[]; // unix seconds of past actual "speak" outcomes
  lastWasSpeak: boolean; // was the previous consider() outcome for this chat "speak"
}

const ROLLING_WINDOW_SECONDS = 3600;
const MAX_SPEAKS_PER_WINDOW = 2;
const REACT_EMOJI = "\u{1F44D}"; // 👍

function isGateAction(x: unknown): x is GateAction {
  if (typeof x !== "object" || x === null || !("action" in x)) return false;
  const action = (x as { action: unknown }).action;
  if (action === "silent" || action === "speak") return true;
  if (action === "react") return typeof (x as { emoji?: unknown }).emoji === "string";
  return false;
}

function hourInTz(unixSeconds: number, tz: string): number {
  const date = new Date(unixSeconds * 1000);
  const formatted = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(date);
  // Some Node/ICU versions render midnight as "24" instead of "00" — normalize.
  return Number(formatted) % 24;
}

function isQuietHour(unixSeconds: number, tz: string): boolean {
  const hour = hourInTz(unixSeconds, tz);
  return hour >= 22 || hour < 8;
}

export class Gatekeeper {
  private deps: GatekeeperDeps;
  private state = new Map<string, ChatState>();

  constructor(deps: GatekeeperDeps) {
    this.deps = deps;
  }

  private stateFor(chatId: string): ChatState {
    let s = this.state.get(chatId);
    if (!s) {
      s = { speakTimes: [], lastWasSpeak: false };
      this.state.set(chatId, s);
    }
    return s;
  }

  /** `tz` is the linked trip's own timezone (an IANA name like "Europe/Paris"), resolved by
   *  the caller per chat — never a fixed zone baked into this class. */
  async consider(chatId: string, transcript: string, tz: string): Promise<GateAction> {
    const state = this.stateFor(chatId);
    const now = this.deps.now();

    // Rule 1: quiet hours always win — never even ask the model.
    if (isQuietHour(now, tz)) {
      state.lastWasSpeak = false;
      return { action: "silent" };
    }

    // Rule 2: call the model; any error or malformed result fails silent.
    let result: GateAction;
    try {
      const raw = await this.deps.decide(transcript);
      if (!isGateAction(raw)) {
        state.lastWasSpeak = false;
        return { action: "silent" };
      }
      result = raw;
    } catch {
      state.lastWasSpeak = false;
      return { action: "silent" };
    }

    if (result.action !== "speak") {
      // react passes through untouched; silent stays silent.
      state.lastWasSpeak = false;
      return result;
    }

    // Rule 3a: consecutive-speak downgrade.
    if (state.lastWasSpeak) {
      state.lastWasSpeak = false;
      return { action: "react", emoji: REACT_EMOJI };
    }

    // Rule 3b: rolling-hour cap downgrade.
    state.speakTimes = state.speakTimes.filter((t) => now - t < ROLLING_WINDOW_SECONDS);
    if (state.speakTimes.length >= MAX_SPEAKS_PER_WINDOW) {
      state.lastWasSpeak = false;
      return { action: "react", emoji: REACT_EMOJI };
    }

    // Model's "speak" survives every cap.
    state.speakTimes.push(now);
    state.lastWasSpeak = true;
    return { action: "speak" };
  }
}

// ── the real `decide` — a raw model call outside any eve agent turn ────────────────────────

const GATE_SYSTEM = [
  "Du er en portvokter for Marcel, en reise-concierge i en familiegruppechat på ferie sammen med dem.",
  "Du får den siste samtalen. Svar KUN med streng JSON, ingen annen tekst:",
  '{"action":"silent"} eller {"action":"react","emoji":"👍"} eller {"action":"speak"}.',
  'Velg "speak" når gruppen faktisk diskuterer noe Marcel kan hjelpe konkret med — mat, lunsj, middag, restaurant eller dagligvarer; strand og bading; aktiviteter, utflukter, løpe- og sykkelturer; kjøring, reisetid, vær eller logistikk for turen — OG han kan tilføre nyttig, faktisk info som ingen har gitt ennå.',
  'Velg "silent" ved ren sosial prat, følelser, spøk, intern koordinering som ikke trenger fakta, noe som allerede er besvart, eller når du er i tvil om han tilfører noe.',
  'Bruk "react" med 👍 når en kort anerkjennelse passer, men det ikke er noe konkret å tilføre.',
  "Ikke tenk på hvor ofte han snakker — egne grenser i koden styrer frekvens. Du vurderer kun om nettopp denne meldingen er et godt øyeblikk å hjelpe.",
].join(" ");

function parseGateAction(text: string): GateAction {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as { action?: string; emoji?: string };
    if (parsed.action === "silent" || parsed.action === "speak") return { action: parsed.action };
    if (parsed.action === "react" && typeof parsed.emoji === "string") return { action: "react", emoji: parsed.emoji };
  } catch {
    // malformed reply — fail silent, per the gatekeeper contract
  }
  return { action: "silent" };
}

export interface MakeGateDecideDeps {
  /** Resolves the model to call, lazily — called on every `decide()` invocation, never at
   *  module scope, so a build with no `MARCEL_MODEL_GATE` set never touches this. */
  model(): LanguageModel;
  /** Token spend for the gate's own raw calls is tracked separately from any agent turn's
   *  spend, exactly like old Marcel's `makeGateDecide`. */
  budget: Budget;
}

/** Builds the `decide` function `Gatekeeper` calls: a RAW `generateText` call outside any eve
 *  agent turn, `maxOutputTokens: 64`, mirroring old Marcel's `makeGateDecide` exactly. */
export function makeGateDecide(deps: MakeGateDecideDeps): (transcript: string) => Promise<GateAction> {
  return async (transcript: string): Promise<GateAction> => {
    const result = await generateText({
      model: deps.model(),
      system: GATE_SYSTEM,
      messages: [{ role: "user", content: transcript || "(ingen samtale ennå)" }],
      maxOutputTokens: 64,
    });
    deps.budget.add(result.usage?.totalTokens ?? 0);
    return parseGateAction(result.text);
  };
}
