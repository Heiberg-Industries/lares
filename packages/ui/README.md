# Lares UI foundations

`src/theme.css` owns the approved shared color, typography, spacing and motion tokens.
The local Instrument Sans and DM Mono font files and their licenses are included here.

The standalone design preview imports this CSS from the repository source. Production
console and website slices can import `@lares/ui/theme.css` when their existing styles
are migrated. Keep runtime data, permissions and actions in those applications; this
package supplies presentation tokens only.

The preview is a visual reference with sample state. Its page-specific refinements
remain in `tools/design-preview` until each page is ported to real application code.
