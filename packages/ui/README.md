# Lares UI

Shared Instrument Sans / DM Mono fonts, semantic tokens and selected shadcn/Radix
primitives for the website and authenticated console. Import `@lares/ui/theme.css`
for tokens alone; that entry does not import interactive console code.

The console imports Tailwind theme/utilities in `app/utilities.css`, then
`@lares/ui/console.css`, then its legacy compatibility stylesheet. Tailwind preflight
is intentionally omitted until the old operational pages are migrated. `console.css`
owns control geometry and semantic button colors, including links rendered as buttons.

- `@lares/ui/primitives/button`, `input`, `dialog`, `tabs`: selected shadcn source.
  Buttons, dialogs and tabs use client boundaries; Input and presentation patterns may
  render on the server. Radix owns dialog focus/trapping and tab keyboard behavior.
- `@lares/ui/patterns`: PageHeader, EmptyState, Notice, StatusBadge, Mark, HomeIcon,
  AgentAvatar. No runtime state, network requests or domain data.
- `@lares/ui/icons`: the approved monochrome Lucide navigation/control icons.
- `@lares/ui/console.css`: reusable console patterns; only tokens define the palette.

The `.dark` class is applied to the root element. The console owns local preference
persistence and initial theme script; marketing may retain its own theme control.
Neither this package nor the console sends analytics.

Shadcn source is MIT licensed: see `LICENSE.shadcn-ui.txt`. Font notices are in
`licenses/`. NPM dependencies retain their own license files. Import only primitives
used by a production consumer; port the remaining preview primitives with their screens.

The standalone `tools/design-preview` remains the approved visual reference with sample
state. Its page-specific refinements are ported individually; its monolithic app and
simulated persistence are never production data adapters.
