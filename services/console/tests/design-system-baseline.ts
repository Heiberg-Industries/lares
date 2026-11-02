// The only accepted exceptions to the design system. The drift test fails if a number rises, and if
// one falls without being lowered here, so this list must not grow. Why each file is on it:
//   app/sign-in/page.tsx   the sign-in door has its own full-screen design
//   components/Nav.tsx     the sidebar's sign-out button has its own look
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
  "components/AppShell.module.css .content: var(--lares-page-width)",
];

/** Hand-built controls and inline styles still in each file. */
export const RAW_LEFT: Record<string, Record<string, number>> = {
  "app/sign-in/page.tsx": { button: 2, select: 0, textarea: 0, fieldset: 1, input: 2, unscrolledTable: 0, style: 0, inlineMaxWidth: 0 },
  "components/Chat.tsx": { button: 1, select: 0, textarea: 0, fieldset: 0, input: 0, unscrolledTable: 0, style: 0, inlineMaxWidth: 0 },
  "components/Nav.tsx": { button: 1, select: 0, textarea: 0, fieldset: 0, input: 0, unscrolledTable: 0, style: 0, inlineMaxWidth: 0 },
  "components/StatePill.tsx": { button: 0, select: 0, textarea: 0, fieldset: 0, input: 0, unscrolledTable: 0, style: 1, inlineMaxWidth: 0 },
};
