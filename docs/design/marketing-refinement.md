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
