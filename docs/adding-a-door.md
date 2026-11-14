# Adding a door

This guide is for a contributor who wants people to reach a Lares agent through a new chat
platform. It follows [ADR-0025](decisions/0025-one-door-layer.md). Read that record first.

**Status.** The shared layer described here is decided but not built yet. Until it is, this
guide tells you what a door will look like, so a new door is not written the old way.

## What a door is

A **door** is one way a person reaches an agent: web chat, Slack and Telegram today.

A door is an **adapter**. It translates between one platform and the agent. It does not decide
anything about people.

An agent sometimes shows a **card**: an approval or a question, with buttons. Pressing a button
is a **tap**. Every rule about cards and taps lives once, in the **layer**: eve's own rules plus
one module in the shared kit (`packages/agent-kit`). The door only carries things to and from
the layer.

The **owner** is the person an installation belongs to. A **member** is any other person the
installation accepts.

## The adapter contract

A door adapter provides exactly five things.

1. **Who sent this.** The sender's identity, as the platform verified it.
2. **What was tapped.** A tap, mapped to the door, the card address and the person who tapped.
   The **card address** is where the card sits on the platform, for example a chat id and a
   message id.
3. **Where a card went.** The card address, recorded when the door posts a card.
4. **One private sentence.** A way to say one fixed sentence to one person so nobody else sees
   it.
5. **Buttons or not.** Whether the door can show buttons on a card.

The sketch below shows the shape. **It is a sketch of an interface that does not exist yet.**
Names and types will change when the layer is built. Do not import it.

```ts
// SKETCH ONLY. Nothing in the repository exports these names yet.

/** A person, as the platform verified them. Never read from message text. */
interface DoorSender {
  door: string;        // for example "example-door"
  platformId: string;  // the platform's own id for the person
}

/** Where a card sits on the platform. Opaque to the layer. */
interface CardAddress {
  door: string;
  place: string;       // for example a chat or thread id
  message: string;     // the platform's id for the card's message
}

interface DoorTap {
  address: CardAddress;
  tapper: DoorSender;
  optionId: string;    // which button
}

interface DoorAdapter {
  /** 1. Who sent this event, or null when the platform did not vouch for it. */
  verifiedSender(event: unknown): DoorSender | null;
  /** 2. The tap in this event, or null when the event is not a tap. */
  tapOf(event: unknown): DoorTap | null;
  /** 3. The address of a card the door has just posted. The layer writes it down. */
  addressOfPostedCard(posted: unknown): CardAddress;
  /** 4. Say one of the layer's sentences to one person, privately. */
  sayPrivately(to: DoorSender, sentence: LayerSentence): Promise<void>;
  /** 5. Whether cards on this door can carry buttons. */
  readonly canShowButtons: boolean;
}

/** A sentence the layer owns. A door cannot make one from its own text. */
type LayerSentence = string & { readonly __fromTheLayer: true };
```

## Choosing a base

Ask these questions in order. Write the answers in your pull request description.

1. **Is the door needed now?** If not, stop.
2. **Does eve already ship a channel for the platform?** Then consider it first, as the base.
   Check that it works fully self-hosted (see below). It still gets the five functions; its own
   card and answer rules do not replace the layer's.
3. **If not: does a Chat SDK adapter exist for the platform that works fully self-hosted?** Then
   start from eve's Chat SDK bridge, `eve/channels/chat-sdk`. Give it a state store that keeps
   its data on the owner's server. Pass the tapper's identity on with the bridge's
   `resolveInputAuth`.
4. **If not, take one short, targeted look elsewhere** for that one platform (for example one
   search for a maintained, self-hostable library). Not a survey of other ecosystems. Write what
   you found in your pull request description.
5. **Only then write a custom eve channel.** It implements the same five functions.

An adapter that sends messages through a hosted relay service is not an option. Lares is
self-hosted and nothing phones home. Some of eve's own channels reach a platform through a
vendor's hosted service; check before you choose one. If the only way to reach a platform is a
hosted relay, the door cannot be added. Say so in an issue instead.

An in-memory state store is for local development only. It forgets everything on a restart.

## The checklist

- [ ] **One adapter file,** implementing the five functions and nothing more. It is written
  once. eve finds a door through a file under a role service's `agent/channels/`; where more
  than one role service uses the door, each such file only registers the one adapter.
- [ ] **Transport check.** The door verifies the platform's signature or secret on every
  request, before anything else. Secrets are read from a file at request time, never when the
  module loads: the build has no secrets.
- [ ] **Claim flow.** The owner connects the door by sending a one-time code in a private chat.
  Use the kit's claim functions (`packages/agent-kit/src/door-authority.ts` and
  `door-channels.ts`). Add your door's kind there. If the kind is not yet allowed in the
  `agent_door_connections` table, that is a migration, and a migration needs the manual
  image-probe run described in `AGENTS.md`.
- [ ] **Allow-list.** The door admits only people on its allow-list. An empty or unreadable
  list admits nobody. The check will be one shared function in the kit (the kit's allow-list
  check); a door calls it and must not carry its own copy. Today each role service has its own
  copy in `lib/principals.ts`; do not add a third.
- [ ] **The shared contract test passes.** It runs your adapter against a fake platform and
  checks the rules in ADR-0025. You do not write rule tests of your own.
- [ ] **Model permission.** Add one row for the door's eve authenticator to the kit's door model
  authority (`packages/agent-kit/src/door-model-authority.ts`), and the door's name to the checks
  that accept only known doors: the `ChatDoor` type (`packages/agent-kit/src/door-authority.ts`),
  Keeper's `door.open` input check (`services/keeper/lib/model-purpose-broker.ts`), and
  `validDoorTurnRequest` and `requireDoorClaim` (`packages/agent-kit/src/budget-model-authority.ts`).
  The door file adds nothing; the sentence a person sees when a turn is refused is the kit's.
- [ ] **A live probe.** `tests/live/<door>.live.mts`, run by hand against the real platform and
  named in your pull request. A fixture is what we believe a platform does; only a live call is
  what it does.
- [ ] **A settings entry for every new environment read.** Each `process.env` name your door
  reads is declared in `packages/vault-format/src/settings.ts`. A test fails on an undeclared
  name.
- [ ] **The namespace check.** Run `node scripts/check-namespace.mjs`. Examples and tests use
  neutral placeholders such as `example-door` and `U-EXAMPLE-ID`.
- [ ] **Platform limits are stated.** Message length, button count, whether a sent message can
  be edited, and whether the door works in private chats only or also in shared rooms.
- [ ] **No new framework patch for this door.** A patch is allowed only at a door-neutral spot
  and with a request to the eve project (ADR-0025 §8).

## What you must not write in a door file

- **No sentence for a person.** Not a refusal, not "no longer waiting", not "too long", not a
  spending-limit line. Pass the layer's sentence on.
- **No rule about people.** Not "only the owner may answer", not "members may not approve", not
  "this is not available in a shared room". Hand the layer the sender or the tap and do what it
  answers.
- **No table or list of cards.** Not in a database, not in memory, not in the platform's state.
  The card record is the layer's.
- **No second copy.** If two door files, or two role services, need the same logic, it belongs
  in the kit. A pull request that copies it is sent back.

If the layer cannot express something your platform needs, do not work around it in the door
file. Open an issue. A change to the layer comes with a change to ADR-0025.

## What a finished door costs

One adapter file, one live probe, and a pass of the shared contract test. No new rules,
sentences or tables.
