# The console's design system

The console has one look, built from one set of named values and one set of shared parts. This page
lists them, says when to use each, and says how the tests hold a page to them.

The models for the look are quiet settings pages: small type, generous space, plain rows, a
twelve-column grid, neutral greys, and one indigo accent.

## The one rule

**Pages never define their own values.** A page, and any component a page uses, takes every colour,
size, radius, shadow and type style from the named values below, and is built from the shared parts.
It sets no width of its own and writes no colour. If a page needs a value or a part that does not
exist, it is added to the shared package, once, for every page.

## Where things live

| What | Where |
| --- | --- |
| The values | `packages/ui/src/console-theme.css` |
| The styles of the shared parts | `packages/ui/src/console.css` (it imports the values) |
| Shared parts with behaviour | `packages/ui/src/primitives/*.tsx`, imported as `@lares/ui/primitives/<name>` |
| Shared parts without behaviour | `packages/ui/src/patterns.tsx`, imported as `@lares/ui/patterns` |
| Icons | `packages/ui/src/icons.ts`, imported as `@lares/ui/icons` |
| The menu and the shell | `services/console/components/Nav.tsx`, `AppShell.tsx` |

The values apply only inside the console. Every rule in `console-theme.css` is scoped to
`html[data-lares="console"]`, which the console's root layout sets. `packages/ui/src/theme.css` is
shared with the design preview and the website and is not changed by the console's look.

Colours are written in OKLCH, with the approved hex value in a comment beside each. Dark mode is
class-based: `.dark` on the root element. The fonts are Instrument Sans and DM Mono. The console
does not turn on Tailwind's reset.

## The values

Use the name. Never copy the value.

### Colour

| Name | Light | Dark | Use |
| --- | --- | --- | --- |
| `--lares-bg` | `#ffffff` | `#17181a` | The page background |
| `--lares-sidebar-bg` | `#f7f7f8` | `#111214` | The menu |
| `--lares-surface` | `#ffffff` | `#1e1f22` | Cards, dialogs, menus |
| `--lares-sunken` | `#f4f4f6` | `#1b1c1f` | Wells, table heads, quiet fills |
| `--lares-text` | `#1f2023` | `#ecedef` | Text |
| `--lares-text-muted` | `#6b6f76` | `#9a9da5` | Secondary text |
| `--lares-text-faint` | `#9a9da5` | `#6f737b` | Group labels, placeholders, things that are not available |
| `--lares-line` | `#e7e8eb` | `#2b2d32` | Card borders, the line between rows |
| `--lares-line-input` | `#d3d5da` | `#4a4d55` | The border of a control |
| `--lares-hover` | `#efeff1` | `#24262a` | Something the pointer is over |
| `--lares-selected` | `#e6e7ea` | `#2c2e33` | The current menu item |
| `--lares-accent` | `#5b5fd6` | `#8f93f5` | The one accent: focus, a switch that is on |
| `--lares-accent-soft` | `#eeeefc` | `#25264a` | The focus ring, soft accent fills |
| `--lares-on-accent` | `#ffffff` | `#111214` | Text on the accent |
| `--lares-primary` | `#1f2023` | `#ecedef` | The primary button |
| `--lares-on-primary` | `#ffffff` | `#17181a` | Text on the primary button |
| `--lares-warning-text`, `-bg`, `-line` | `#9a6200`, `#fff6e0`, `#f0d48a` | `#e3bd66`, `#2e2715`, `#5a4a1f` | Something needs the person |
| `--lares-error-text`, `-bg`, `-line` | `#b3352b`, `#fdeceb`, `#f2b8b3` | `#f29a92`, `#331b19`, `#6a2f2a` | Something failed |
| `--lares-success-text`, `-bg` | `#2c7a52`, `#e9f6ef` | `#86cfa6`, `#16291f` | Something worked |
| `--lares-info-text`, `-bg` | `#2f62c9`, `#eaf1fd` | `#8fb2f5`, `#182338` | Something to know |
| `--lares-shadow-overlay` | two soft layers | one deep layer | Only things that float over the page: dialogs, sheets, menus, tooltips |

Flat surfaces have no shadow. Structure comes from the one-pixel line.

The shadcn names that the parts already use (`--background`, `--foreground`, `--card`, `--border`,
`--input`, `--ring`, `--primary`, `--muted-foreground`, `--destructive` and the rest) point at these
values inside the console, so older styles follow the new look without being rewritten. New styles
use the `--lares-*` names.

### Size

| Name | Value | Use |
| --- | --- | --- |
| `--lares-sidebar-width` | 248px | The menu column |
| `--lares-page-width` | 960px | The page |
| `--lares-gutter` | 24px (16px on a phone) | Between columns, and between blocks on a page |
| `--lares-grid-columns` | 12 (4 on a phone) | The page grid |
| `--lares-control-radius` | 6px | Buttons, fields, menu items |
| `--lares-card-radius` | 10px | Cards, notices |
| `--lares-dialog-radius` | 12px | Dialogs |
| `--lares-control-height` | 32px (44px on a phone) | Buttons and fields |
| `--lares-control-height-sm` | 28px (44px on a phone) | Small buttons |
| `--lares-control-text` | 13px (16px on a phone) | Text typed into a field |
| `--lares-short-field-width` | 6rem | A box for a number or another value of a few characters |
| `--lares-switch-width`, `--lares-switch-height` | 34px, 20px | The switch |
| `--lares-row-height` | 56px | The least height of a row |
| `--lares-menu-item-height` | 30px | The least height of a menu item |
| `--lares-menu-icon` | 15px | Icons in the menu |
| `--lares-notice-icon` | 18px | The round icon of a notice |
| `--lares-badge-dot` | 6px | The dot in a badge |
| `--lares-focus-ring` | 3px of `--lares-accent-soft` | Around a focused field, with an accent border |

"On a phone" means a screen 760px wide or narrower. Field text is 16px there so the phone does not
zoom the page when a field is tapped. Spacing inside parts uses the shared 4px steps
(`--space-1` to `--space-24`).

### Type

| Name | Value | Use |
| --- | --- | --- |
| `--lares-type-body` | 13px/20px | Everything, unless named below |
| `--lares-type-title` | 20px/28px, weight 600, with `--lares-tracking-title` (-0.01em) | The page title |
| `--lares-type-section` | 13px/20px, weight 600 | A section or card heading |
| `--lares-type-secondary` | 12px/16px | Secondary text, in `--lares-text-muted` |
| `--lares-type-label` | 13px/20px, weight 500 | Buttons, field labels, row titles |
| `--lares-type-menu-label` | 11.5px/16px | Menu group labels, in `--lares-text-faint` |
| `--lares-type-badge` | 12px/20px, weight 500 | Badges |

## The grid

`Page` lays its children on twelve columns with a 24px gutter. At 760px and below there are four
columns with a 16px gutter. The page is 960px wide at most and sits in the middle of the page area.

A child of `Page` spans every column unless it is a `Col`:

```tsx
<Page>
  <PageHeader title="Members" />
  <Col span={8}>…the list…</Col>
  <Col span={4}>…the side notes…</Col>
</Page>
```

| Span | Class | On a wide screen | On a phone |
| --- | --- | --- | --- |
| 12 | `lares-col-12` | The whole row | The whole row |
| 8 | `lares-col-8` | Two thirds | The whole row |
| 6 | `lares-col-6` | Half | The whole row |
| 4 | `lares-col-4` | One third | The whole row |
| 3 | `lares-col-3` | One quarter | Half |

These five are the only spans. A page that wants a narrower block uses a `Col`; it never sets a
`width`, a `max-width`, a width class or columns of its own. The space between blocks is the grid's
gap, so a block placed directly on the page adds no outer margin.

`Page` still accepts `width="narrow"`. Both widths are the one page width now; the property stays so
existing pages do not have to change, and a page that wants narrower content uses a `Col`.

## The building blocks

### Layout

| Part | From | Use it for |
| --- | --- | --- |
| `Page` | `patterns` | The frame of every page. One per route, nothing beside it. |
| `Col` | `patterns` | A block that takes part of the row. |
| `PageHeader` | `patterns` | The page title, one line of description, and the page's main actions. The title is the page's menu words. |
| `Card` and `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` | `primitives/card` | A group of related things: a flat surface with a line and 10px corners. |
| `Rows`, `Row` | `patterns` | A list of settings or items inside a card. Each row is at least 56px high, with a line between rows; the control or badge goes on the right. |
| `EmptyState` | `patterns` | A list with nothing in it yet. |
| `Sheet` and its parts | `primitives/sheet` | A panel from the edge of the screen, for a task beside the page or a menu on a phone. Give it a `SheetTitle`. |
| `Dialog` and its parts | `primitives/dialog` | A question or a short form that must be answered before going on. |
| `Tabs` | `primitives/tabs` | Views of one thing. |

### Messages and status

| Part | From | Use it for |
| --- | --- | --- |
| `Notice` | `patterns` | Every message to the person. See the tones below. |
| `Alert`, `AlertTitle`, `AlertDescription` | `primitives/alert` | The box under `Notice`. Use it directly only for a message with its own title and description. |
| `Badge` | `primitives/badge` | A status in a word or two: a pill with a dot. Variants `neutral`, `success`, `warning`, `error`, `info`, `accent`. |
| `StatusBadge` | `patterns` | The older name for the same pill (`quiet`, `attention`, `success`, `error`). |
| `Tooltip` and its parts | `primitives/tooltip` | A hint for an icon or a clipped word. Never the only place a fact lives: it does not open on a phone. |

`Notice` has five tones, each with one colour and one round icon:

| Tone | Look | Announced as |
| --- | --- | --- |
| `info` (the default) | Blue, "i" | Status |
| `working` | Grey, a turning icon | Status |
| `success` | Green, a tick | Status |
| `needs-you` | **The one warning look:** amber, "!" | Status |
| `error` | **The one error look:** red, "×" | Alert |

There is one warning look and one error look in the whole console. The older hand-made classes
`lares-form-error`, `lares-operational-error`, `lares-status-error` and `lares-form-success` take the
same looks through the stylesheet: as a paragraph or a block they are the full message box, and
inside a sentence or a table cell they are the status colour only. New code uses `Notice`.

### Controls

| Part | From | Use it for |
| --- | --- | --- |
| `Button` | `primitives/button` | Every button, and every link that looks like one. One `default` (primary) button per view; `outline` for the rest; `ghost` for quiet actions; `destructive` for deleting. `size="sm"` is 28px. |
| `Input`, `Textarea`, `Select` | `primitives/input`, `textarea`, `select` | Fields. Focus is the accent border and a soft ring. |
| `Checkbox`, `Radio` | `primitives/checkbox` | Choices inside a form that is submitted later. |
| `Switch` | `primitives/switch` | A setting that applies as it is flipped. The accent when on. |
| `ListEditor` | `primitives/list-editor` | A list typed as one box per value, with a remove button beside each box and an Add button under them. It only holds what is typed: the page decides how the list is stored, and drops boxes left empty. `size="short"` for numbers; `fixed` for a list that always has the same number of values. |
| `Field`, `Choice`, `FieldGroup` | `patterns` | The label, hint and grouping around a control. |
| `ToolList`, `ToolRow` | `patterns` | A list of an agent's or a server's tools. |
| Dropdown menu | `primitives/dropdown-menu` | A short list of actions behind one button. |

### The menu

`Sidebar` and its parts (`primitives/sidebar`) are the menu column: `SidebarProvider`, `Sidebar`,
`SidebarHeader`, `SidebarContent`, `SidebarGroup`, `SidebarGroupLabel`, `SidebarMenu`,
`SidebarMenuItem`, `SidebarMenuButton`, `SidebarMenuBadge`, `SidebarFooter`, `SidebarTrigger` and
`SidebarInset`. On a phone the same contents open in a sheet from the left; the stylesheet decides
which one shows.

The console's menu is data in `services/console/components/Nav.tsx`:

- `OWNER_MENU` is the owner's groups and pages, in order. A page's address is its menu words in
  lower case with dashes: **Alert routing** is `/alert-routing`.
- `COMING` is the one list of pages that are announced but not built. Each shows greyed with a
  "Coming" tag and is plain text, not a link. When one ships, delete its line and add the page to
  its group.
- `MEMBER_MENU` is what a member who is not the owner sees.
- Exactly one entry is current: the one whose address is the longest match for the page address.
- Each entry has its own icon, from `@lares/ui/icons`. An icon that is missing is added there.

## How the tests enforce it

All in `services/console/tests/`. Run them with
`pnpm -C services/console exec vitest run tests/design-system-drift.test.ts tests/design-system-controls.test.tsx tests/nav-connections.test.tsx tests/menu-page-titles.test.tsx`.

| Test | What fails it |
| --- | --- |
| `design-system-drift.test.ts` | A route that does not return exactly one `Page`. A new `max-width`, fixed width, width class or `grid-template-columns` in the console's own stylesheets or pages. A column span that is not one of the five. A hand-built button, field or inline style. More uses of a `lares-operational*` class in a file than the list allows. A colour or width in the shell's stylesheet. |
| `design-system-baseline.ts` | Not a test: the lists of exceptions the drift test compares against. Each list may only shrink. When a number falls, the test fails until the list is lowered to match, so it cannot go stale. |
| `design-system-controls.test.tsx` | A shared part that loses its markup, its accessible name or role, or its keyboard behaviour. A value that changes, a colour written outside `console-theme.css`, or a console value that leaks out of the console's scope. A second warning or error look. |
| `nav-connections.test.tsx` | A menu that is not exactly the agreed one for the owner or for a member, a "coming" entry that can be followed, more or fewer than one current entry, or a phone menu that is not a named sheet that closes on Escape and returns focus. |
| `menu-page-titles.test.tsx` | A menu page whose title is not its menu words. Pages that do not match yet are on a short list in the test; the test also fails when a listed page does match, so the list empties as pages are renamed. |
| `tests/actions/` | A page, action or route that appears, disappears or changes who may use it. A change of look must leave this inventory alone, apart from the addresses it meant to rename. |

## Changing the system

A new value, span or part is a change to `packages/ui`, in its own right, with its row added to this
page and to the tests above. It is never a line in one page's stylesheet.
