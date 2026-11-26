// The only accepted exceptions to the design system. The drift test fails if a number rises, and if
// one falls without being lowered here, so this list must not grow. Why each file is on it:
//   app/sign-in/page.tsx   the sign-in door has its own full-screen design
//   components/StatePill.tsx  the dot colour comes from data
//   components/Chat.tsx    the agent picker's menu trigger is a button with its own look
// The width limits left are layout of components that are not forms or pages: chat, dialog, menu,
// message bubble, sign-in.

/** Width limits in the console's own stylesheets, as "file selector: value". */
export const CSS_WIDTH_LIMITS: string[] = [
  "app/globals.css .lares-chat-selector select: 240px",
  "app/globals.css .lares-chat-intro p: 480px",
  "app/globals.css .lares-chat-selector select: 160px",
  "app/globals.css .lares-table-scroll: 100%",
  "app/globals.css .lares-short-input, .lares-field-label > [data-slot=\"input\"].lares-short-input: 6rem",
  "app/globals.css .lares-chat-selector: 70%",
  "app/globals.css .lares-agent-menu: calc(100vw - 32px)",
  "app/globals.css .lares-message: 65ch",
  "app/globals.css .lares-create-dialog: 620px",
  "app/sign-in/sign-in.module.css .headline: 11ch",
  "app/sign-in/sign-in.module.css .lead: 40ch",
  "app/sign-in/sign-in.module.css .card: 380px",
  "app/sign-in/sign-in.module.css .headline: none",
  "components/AgentDetail.module.css .tabs: 100%",
  "components/AgentsList.module.css .hint: var(--measure)",
];

/** Block-sized fixed widths in the console's own stylesheets, as "file selector property: value". Width comes from
    Page and Col; these are a menu, a table that scrolls and a column of row controls. The list may only shrink. */
export const CSS_FIXED_WIDTHS: string[] = [
  "app/globals.css .lares-agent-menu width: 300px",
  "app/globals.css .lares-table-scroll table min-width: 620px",
  "app/globals.css .lares-row-controls min-width: 14rem",
];

/** Column layouts the console's own stylesheets still set for themselves, as "file selector: value". Page and Col
    own the page's columns; these are older sections, and the sign-in door's own two halves. The list may only shrink. */
export const CSS_COLUMN_LAYOUTS: string[] = [
  "app/globals.css .lares-master-detail: repeat(auto-fit, minmax(min(100%, 20rem), 1fr))",
  "app/globals.css .lares-deadline-form: repeat(auto-fit, minmax(min(100%, 11rem), 1fr))",
  "app/globals.css .lares-connections: repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
  "app/globals.css .lares-review: 140px 1fr",
  "app/globals.css .lares-review: 1fr",
  "app/globals.css .lares-purpose: 18px 1fr",
  "app/sign-in/sign-in.module.css .page: minmax(0, 1.1fr) minmax(0, 1fr)",
  "app/sign-in/sign-in.module.css .page: minmax(0, 1fr)",
  "components/AgentsList.module.css .table tr: repeat(2, minmax(0, 1fr))",
];

/** How many times each file still writes a lares-operational* class. These pages predate the shared parts; each
    slice that rebuilds one lowers its number, and a file leaves the list at zero. No number may rise. */
export const OPERATIONAL_LEFT: Record<string, number> = {
  "app/alert-routing/catalogue/page.tsx": 3,
  "app/alert-routing/page.tsx": 4,
  "app/alerts/page.tsx": 4,
  "app/backups/page.tsx": 6,
  "app/deadlines/page.tsx": 10,
  "app/integrations/[id]/page.tsx": 4,
  "app/meeting-follow-ups/page.tsx": 3,
  "app/quiet-hours-and-delivery/page.tsx": 13,
  "app/saved-preferences/page.tsx": 11,
  "app/writing-style/page.tsx": 11,
  "components/BriefLanguageControl.tsx": 2,
  "components/ConsumerSwitches.tsx": 1,
  "components/DeliveryGrid.tsx": 1,
  "components/JsonEditor.tsx": 1,
  "components/NotionProposalsCard.tsx": 7,
  "components/ProactivityControls.tsx": 1,
  "components/ScheduleHoursControl.tsx": 2,
  "components/ServicePermissions.tsx": 2,
  "components/TasteImport.tsx": 2,
};

/** Hand-built controls and inline styles still in each file. */
export const RAW_LEFT: Record<string, Record<string, number>> = {
  "app/sign-in/page.tsx": { button: 2, select: 0, textarea: 0, fieldset: 1, input: 2, unscrolledTable: 0, style: 0, inlineMaxWidth: 0 },
  "components/Chat.tsx": { button: 1, select: 0, textarea: 0, fieldset: 0, input: 0, unscrolledTable: 0, style: 0, inlineMaxWidth: 0 },
  "components/StatePill.tsx": { button: 0, select: 0, textarea: 0, fieldset: 0, input: 0, unscrolledTable: 0, style: 1, inlineMaxWidth: 0 },
};
