/**
 * lib/delivery.ts - where an unprompted message goes, and the gate it passes on the way.
 *
 * The owner's choice is the optional `delivery` map in the agent's definition (kit:
 * `@lares/agent-kit/delivery`). This file turns it into one decision per send: `routeDelivery`
 * picks the first connected door in the owner's list, falling through to web chat (always there),
 * and hands the schedule a `Routed` - the door, its address, the proactivity gate already bound to
 * that door (`lib/initiation.ts`), and a way to write to the web inbox.
 *
 * Generalises what `agent/schedules/reminders.ts` did for one kind (a pinned door with a Telegram
 * fallback) to every schedule that speaks unprompted. The gate is unchanged, so quiet hours,
 * do-not-disturb and the daily limits apply to whichever door is chosen - web chat included, as
 * its own door (`WEB_DOOR`).
 *
 * An agent whose definition has no `delivery` entry for a kind tries today's door first and, when
 * that is not connected, falls back to web chat with a note - nothing is dropped silently.
 */
import { getPool } from "@lares/agent-kit/db";
import { doorsOf, type LoadedDefinition } from "@lares/agent-kit/definition";
import {
  DELIVERY_KIND_LABEL, routeFor,
  type DeliveryDoor, type DeliveryKind,
} from "@lares/agent-kit/delivery";

import { agentName } from "./agent-name.js";
import { initiate, type DoorInitiate } from "./initiation.js";
import { allowedSlackUserIds, doorId, ownerId, primaryTelegramChatId } from "./principals.js";
import { slackDmChannelId } from "./slack-dm-channel.js";
import { captureWebContinuityFence, putInbox, recordFallback, type WebContinuityFence } from "./web-inbox.js";

/** The ledger's door string for web chat. One door: quiet hours and limits count it as one. */
export const WEB_DOOR = "web:inbox";

export interface Routed {
  kind: DeliveryKind;
  label: string;
  door: DeliveryDoor;
  /**
   * WHO the message is for on this door: the Telegram chat id, the Slack USER id, or the owner id
   * for web chat. This is the id the ledger door (`doorId`), the conversation's continuity
   * identity and a plain text post are keyed on, and it stays that.
   *
   * For Slack it is NOT the address to start a conversation at: use `conversationAddress()`.
   */
  target: string;
  /**
   * WHERE a conversation on this door is started: what `to(channel, ...)` must be given.
   *
   * Telegram: the chat id, same as `target`. Web chat: the owner id (no conversation is started
   * there). Slack: the owner's direct-message channel (`D...`), looked up once from the user id
   * and cached (`lib/slack-dm-channel.ts`). A conversation started at the user id itself posts
   * approval cards whose buttons reach nothing, because the tap carries `D...` and eve filed the
   * conversation under `U...`.
   *
   * Rejects when the Slack lookup fails. It never falls back to the user id: the send has to
   * stop, which the gate records as "not sent" so the item stays eligible.
   *
   * It is a second field, and asynchronous, because `routeDelivery` is called synchronously by
   * every schedule and `target` is also the identity those callers key on.
   */
  conversationAddress(): Promise<string>;
  /** The ledger door this send is counted against. */
  doorId: string;
  /** "Morning brief went to web chat: Telegram is not connected", or null on a first-choice send. */
  note: string | null;
  /** The proactivity gate, bound to this door. Records the fallback note when the message goes out. */
  gate: DoorInitiate;
  /** The agent's voice, for generating the text of a web message. */
  voiceMd: string;
  /** Write a message to the web inbox. `itemKey` defaults to the item the gate is currently sending. */
  inbox(m: { itemKey?: string; title: string; body: string; context?: string; continuityFence?: WebContinuityFence }): Promise<void>;
  /** Snapshot current account and agent-use epochs before generated web copy is produced. */
  captureContinuityFence(): Promise<WebContinuityFence | undefined>;
}

export interface Targets { telegram?: string; slack?: string }

/** Where each chat door would deliver on this installation right now; absent = not connected. */
export function liveTargets(env: NodeJS.ProcessEnv = process.env): Targets {
  const telegram = primaryTelegramChatId(env);
  const slack = allowedSlackUserIds(env)[0];
  return { ...(telegram ? { telegram } : {}), ...(slack ? { slack } : {}) };
}

/**
 * Is this chat door usable for `kind`? It needs an address (the owner's chat id) and, when the
 * owner has chosen doors for the kind, the door switched on in the definition. Web chat is always
 * usable and is not asked about here.
 */
export function connectedDoors(
  loaded: Pick<LoadedDefinition, "definition">,
  kind: DeliveryKind,
  targets: Targets = liveTargets(),
): (door: DeliveryDoor) => boolean {
  const mapped = loaded.definition.delivery?.[kind] !== undefined;
  const enabled = new Set(doorsOf(loaded.definition).filter((d) => d.enabled).map((d) => d.kind));
  return (door) => door !== "web" && targets[door] !== undefined && (!mapped || enabled.has(door));
}

export interface RouteDeps {
  targets?: Targets;
  /** The gate, injectable for tests. Defaults to the real one bound to the schedule name. */
  initiate?: typeof initiate;
  db?: Parameters<typeof putInbox>[0];
  /** The Slack direct-message lookup, injectable for tests. Defaults to the real, cached one. */
  slackDmChannel?: (userId: string) => Promise<string>;
}

/**
 * Decide the door for one send. Returns null when nothing can carry the message: an agent with no
 * delivery entry for this kind whose single, original door is not connected. The caller logs and
 * skips, as it always did.
 */
export function routeDelivery(
  kind: DeliveryKind,
  loaded: Pick<LoadedDefinition, "definition" | "voiceMd">,
  deps: RouteDeps = {},
): Routed | null {
  const label = DELIVERY_KIND_LABEL[kind];
  const delivery = loaded.definition.delivery;
  const targets = deps.targets ?? liveTargets();
  const route = routeFor(kind, delivery, connectedDoors(loaded, kind, targets), label);
  if (route.door === null) return null;

  const owner = ownerId();
  const agent = agentName();
  const door = route.door;
  const target = door === "web" ? owner : targets[door]!;
  const ledgerDoor = door === "web" ? WEB_DOOR : doorId(door, target);
  const send = deps.initiate ?? initiate;
  const db = () => deps.db ?? getPool();
  const note = route.fallbackNote;
  const dmChannel = deps.slackDmChannel ?? ((userId: string) => slackDmChannelId(userId));

  // The item the gate is sending right now, so a callback that does not carry its own key (the
  // deadline ladder's `send(text)`) still writes its inbox row under the ledger's key.
  let current: string = kind;
  const gate: DoorInitiate = async (init, run) => {
    current = init.itemKey;
    const outcome = await send(kind, { ...init, door: ledgerDoor }, run);
    if (outcome.sent && note) await recordFallback(db(), { owner, agent, itemKey: init.itemKey, note });
    return outcome;
  };

  return {
    kind, label, door, target, doorId: ledgerDoor, note, gate, voiceMd: loaded.voiceMd,
    conversationAddress: async () => (door === "slack" ? dmChannel(target) : target),
    inbox: (m) => putInbox(db(), { owner, agent, kind, ...m, itemKey: m.itemKey ?? current }),
    captureContinuityFence: () => captureWebContinuityFence(db(), owner, agent),
  };
}
