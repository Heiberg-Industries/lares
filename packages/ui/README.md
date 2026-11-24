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
- `@lares/ui/primitives/select`, `textarea`, `checkbox` (Checkbox, Radio): the browser's
  own controls in the design system's appearance, so forms post and phones pick as usual.
- `@lares/ui/primitives/switch`: an on/off Switch (Radix). It takes effect as it flips, so use it
  for settings that apply at once; use Checkbox for choices inside a form that is submitted later.
  Name it with `aria-label` or a wrapping label.
- `@lares/ui/patterns`: Page, PageHeader, EmptyState, Notice, ToolList, ToolRow, StatusBadge, Field,
  Choice, FieldGroup, Mark, HomeIcon, AgentAvatar. No runtime state, network requests or domain data.
- `@lares/ui/icons`: the approved monochrome Lucide navigation/control icons.
- `@lares/ui/console.css`: reusable console patterns; only tokens define the palette.

**Notice tones.** `<Notice tone="…">` has five tones, each with one colour and one icon, so a status,
an alert and an error can be told apart at a glance: `info` (neutral, the default), `working` (a
spinning icon; use while something runs), `success` (done), `needs-you` (the person must act or
decide) and `error` (something failed). Only `error` is announced to screen readers as an alert; the
others are quiet status text. `error` on its own is kept as shorthand for `tone="error"`.

**Tool lists.** A list of an agent's or server's tools is a `ToolList` of `ToolRow`s, never a
comma-joined sentence. A row has the tool's name, an optional kind badge (`kind="read"` shows
"Looks things up", `kind="change"` shows "Changes something"), a short description (a long one folds
into a line that opens), a `control` slot on the right (normally a Switch) and `children` for extra
controls underneath.

Every console route renders one `Page`: `width="wide"` (the default) for tables and lists,
`width="narrow"` for forms, settings and chat. Sections fill their page and set no width of
their own. `services/console/tests/design-system-drift.test.ts` holds pages and controls to
this.

The `.dark` class is applied to the root element. The console owns local preference
persistence and initial theme script; marketing may retain its own theme control.
Neither this package nor the console sends analytics.

Shadcn source is MIT licensed: see `LICENSE.shadcn-ui.txt`. Font notices are in
`licenses/`. NPM dependencies retain their own license files. Import only primitives
used by a production consumer; port the remaining preview primitives with their screens.

The standalone `tools/design-preview` remains the approved visual reference with sample
state. Its page-specific refinements are ported individually; its monolithic app and
simulated persistence are never production data adapters.
