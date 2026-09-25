# Lares interactive design preview

A standalone React preview of the agreed console structure and marketing direction.
Built 2026-09-25. This is reviewable UI code with in-memory sample state, not the live
Next.js console or a working Eve connection.

## Review

Open the generated `dist/index.html` directly in a browser. It is a single file with
embedded JavaScript, CSS, and Instrument Sans / DM Mono fonts; no CDN or server is
required. Console opens first. Use the top bar for Marketing and light/dark mode.
All changes reset on reload. Nothing is sent, stored or connected externally.

Try: Agents > Create agent; edit instructions; Access; Schedules; Actions > Retire
or Delete; Home > Review draft; Chat > send a sample message; Marketing > signup.

## Build and maintain

```sh
npm ci
npm run dev
npm test
npm run build
```

Vite builds the portable artifact. React components can be ported into the existing
Next.js console after design review. Vite is preview tooling, not a proposed change
to the production framework. This folder is intentionally outside the pnpm workspace
package globs so its npm lockfile and prototype dependencies remain isolated.

## Actual dependencies and reused code

- React 19 and Tailwind CSS 4.
- Official shadcn/ui registry source: Button, Input, Textarea, Label, Tabs, Dialog,
  Dropdown Menu, Switch, Select and Table. Registry snapshots are under `upstream/`.
- AI Elements Conversation, ConversationContent and ConversationScrollButton from
  the official registry; uses use-stick-to-bottom. AI SDK supplies its message types.
- Approved Lares tokens now come from `packages/ui/src/theme.css`, shared with future
  production consumers. The same self-hosted Instrument Sans and DM Mono files are
  bundled from that package; semantic color values remain unchanged.
- Brand mark and bracket geometry follow the supplied SVGs. Marketing Grain follows
  the kit's SVG turbulence treatment. Selected original marketing copy is retained;
  launch assertions and placeholder prices are omitted or labeled as preview copy.

Changes to upstream components: local import paths; neutral hover/focus fills in
place of the attention color; ink destructive-button fills, in line with Lares tokens.
The shell and product views compose these components; they are not a stock dashboard
layout. Sidebar and task-specific approval details remain Lares code.

## Preview scope and limitations

Working sample interactions: navigation, search, agent create/edit/retire/delete,
permissions, schedule switch, approval review, chat composer/sample replies, theme,
connection-state simulation and marketing signup feedback.

Simplified placeholders: detailed specialist tools, mailbox writing preferences,
backup/recovery, cost data and actual account setup. Chat replies are predefined
sample text, not streamed model output. No Eve runtime requests are made.
Permission choices illustrate the agreed UI; production must use the effective
capabilities/locked actions from the existing permissions board. No live read grant
or runtime behaviour is inferred from this sample data.

Before production port: preserve Eve useEveAgent, respond, steering, reconnect,
expiry, unknown-outcome handling and authenticated proxy semantics. Keep one source
of truth for shared and agent-specific settings. Implement real restart/pending state
feedback. Revisit field-level editor saving and dirty-form dismissal in that port.

## Verification

TypeScript and production build pass. Seven DOM interaction tests cover lifecycle,
duplicate-name validation, approval feedback, chat reset, theme and sample signup.
The generated artifact has embedded fonts and no external script/style references.
Motion uses CSS and AI Elements scroll behaviour, with reduced-motion overrides.
Browser visual review was not performed due the earlier browser access restriction;
manual visual review at desktop/mobile widths remains required.

Upstream component and font licences are included in `licenses/`. Exact dependency
versions are locked in package-lock.json.


## Console refinement — screenshot review, 2026-09-25

Owner requested softer console surfaces and controls; this supersedes the original
kit's strict four-pixel corner treatment for the console. The marketing design is
unchanged pending its own review.

- House/bracket appears only on Home in console navigation; other destinations use
  distinct monochrome Lucide icons. Agent identity uses supplied geometric role symbols. Tools is a smaller,
  separated section label without an icon or interactive styling.
- Console controls use moderate 10px rounding, surfaces 12–16px, and agent selectors,
  status labels and suggestion chips use pills. Palette and font families stay intact.
- Larger table/body labels, quieter dividers and padded settings groups reduce the
  rigid grid appearance. Left-aligned page content reduces the large sidebar gap.
- Chat height is capped, with a centered greeting, quieter conversation surface,
  distinct author labels, rounded composer and less repeated framing.
- All adjustments are scoped to the console, including components rendered in portals.

Seven interaction tests and TypeScript/build pass after this pass. The owner-provided
screenshots informed the changes; a new browser visual check has not been performed.

## Chat identity refinement — 2026-09-25

- A standard dropdown in the chat header replaces the detached agent pills.
  Each agent keeps its sample conversation and draft while switching on the Chat
  page; navigating away or reloading still resets chat state.
- User messages use primary ink and agent messages use pale moss. Author labels
  and alignment also distinguish senders; dark mode uses the original theme tokens.
- Default symbols adapt the supplied chief-of-staff, travel and loop-four artwork
  as inline vectors. No house icon is used for agent identity.
- Create/edit supports optional PNG/JPG/WebP images up to 2 MB, centered in the
  shared avatar component, with a restore-default action. Uploads remain in memory
  and are never sent anywhere. Production needs validated image decoding/resizing,
  storage and persistence.
- Navigation hover is lighter than selection. Reconnect-needed uses the existing
  attention color and an explicit text label.
- Follow-up implementation scope: unsaved-edit handling, meaningful empty-state
  actions, persistent conversations and upload storage.

Added interaction checks for conversation switching and avatar save/reset.
Visual assessment is based on the supplied screenshots; the updated artifact
requires the owner's browser review, including mobile and dark mode.

## Marketing refinement — 2026-09-25

The owner approved the softer console language for marketing, with an animated
grainy hero, static offering cards and restrained surface texture inspired by
the supplied references. Colors and fonts remain the Lares tokens.

- Hero uses slow CSS transforms, stationary SVG grain and faint diagonal texture.
  Pause/play is available; reduced-motion renders a static background.
- Cards share the texture treatment with different static light compositions.
- Buttons, inputs, product illustration and signup use softer corners. The hero
  primary link explicitly sets its foreground token to fix invisible text.
- The sample console reuses AgentBadge and the existing role symbols.
- Offerings have plain-language subtitles; development status and unconfirmed
  availability/pricing remain explicit. Signup remains entirely local.
- Dark mode strengthens form boundaries and secondary text; responsive overrides
  stack offering cards, product content and signup on narrow screens.

Validation: TypeScript and build pass; seven interaction tests pass, including
animation pause/resume and the local signup flow. No new browser visual check was
performed because of the existing browser-access restriction. Review the new
artifact in both themes and on mobile before accepting the visual treatment.

### Marketing screenshot follow-up

Hero light cycles now use 14/19-second movement with stronger moss contrast.
The grain gently drifts over five seconds; pause and reduced-motion stop both
light and grain. Offering cards remain static and unchanged. Signup uses a moss
field, clean form surfaces, shorter copy and aligned desktop outer edges.
TypeScript/build and all seven interaction checks pass. Owner browser review
is still needed for motion intensity, dark mode and mobile layout.

### Solid signup/footer — approved 2026-09-25

Signup and footer now share a full-width, content-height solid background:
light stone grey with a green undertone in light mode, near-black in dark mode.
The outer signup card border/radius and gradient are removed. Content retains
the page grid, white/light-mode fields and lighter dark-mode fields. The footer
uses a quiet inset divider. Hero and offering card treatments are unchanged.
