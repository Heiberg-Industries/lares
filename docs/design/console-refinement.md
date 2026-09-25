# Console refinement direction

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
