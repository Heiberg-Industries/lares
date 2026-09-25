# Lares motion direction

Recorded 2026-09-25. Owner requested subtle motion across the marketing page and
console, including navigation, chat, elements and buttons. This is an accepted
requirement for the upcoming implementation plan; animations are not implemented yet.

## Intent and implementation

Motion should explain a state change, connect related views or give feedback.
Keep it quiet and consistent with the original Lares colors, fonts and restrained
visual language. Prefer installed component transitions and CSS. Add an animation
library only if a concrete interaction cannot be handled cleanly by those tools.
Do not add a second animation system for equivalent effects.

Initial tuning values (proposed, subject to visual review): feedback 100–150 ms;
menus, tabs and content entrance 150–200 ms; marketing reveals 200–300 ms.
Use shared duration/easing tokens, mostly opacity and small transforms (2–6 px).
Avoid bounce, overshoot, decorative loops and large movements.

## Surfaces

- Navigation: keep the console shell stable. Use a short fade for newly available
  page content and a subtle active-item transition. Start navigation immediately;
  never wait for an exit animation. Preserve focus and predictable scroll position.
- Chat: animate a new message once with a brief fade/small rise. Keep streamed text
  immediate; no artificial typewriter delay or animation on every token/re-render.
  Preserve reading position when the user scrolls up, and offer Jump to latest.
  Show busy/reconnecting states without shifting the message layout.
- Buttons: subtle color/border feedback for hover and press. Keep hit targets and
  labels stable. Preserve keyboard focus indication and disabled/loading states.
- Menus, dialogs and sheets: reuse component entrance/exit behaviour with shared
  timing. Respect focus trapping/restoration and keyboard interactions.
- Forms and records: gently reveal validation and saved feedback; keep row order
  stable during review. Do not animate an unconfirmed operation as successful.
- Marketing: a restrained hero entrance and optional one-time section reveals.
  Content remains visible if JavaScript fails. Avoid scroll hijacking, parallax
  and long cascades that delay reading or hide the call to action.

## Acceptance checks

Respect prefers-reduced-motion across both surfaces: remove movement, animated
scrolling and repeated animation, while retaining immediate state feedback. Verify
keyboard focus, long streaming conversations, preserved scroll position, mobile
navigation, loading/error states and performance on a modest device. Motion must
not delay actions, cause layout shifts or replay on routine data refreshes.

Review one navigation transition, one agent form, one streaming conversation and
one marketing section before spreading the shared motion treatment.
