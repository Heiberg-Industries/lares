# Console UI stack — accepted decision

Date: 2026-09-25. Status: owner accepted shadcn/ui + Tailwind CSS 4 and a selected AI Elements pilot.
The isolated [design preview](../../tools/design-preview/README.md) now implements
the selected UI foundation with sample data. Production dependencies remain unchanged.
Structure is agreed in [console-structure.md](console-structure.md). A detailed plan
and smaller implementation-agent assignments follow the component decision.

## Lean implementation constraint

Owner confirmed 2026-09-25: the UI supports the product. Prefer components and
behaviours supplied out of the box whenever they meet the agreed user journeys.

- Use the original downloaded Lares design kit and supplied screenshots as the
  reference for existing colors and fonts, not the divergent structural preview.
- Apply a thin shared theme to standard shadcn/ui and selected AI Elements components.
  Keep their default layouts, spacing and interactions where these work well.
- Custom code must solve a concrete Lares need: agent lifecycle, access scope,
  approval details, runtime state or Eve integration. Avoid cosmetic rewrites of
  working library components and speculative component abstractions.
- Add only components needed by the current implementation slice. Expand shared
  components when real repeated use justifies them.
- Preserve accessibility, responsive behaviour and clear loading/error states;
  verify the configured components in the actual flows.
- Continue with a bounded implementation plan and smaller implementation agents
  later. The decision approves the stack and approach; it does not represent a
  completed dependency integration or approve every optional library below.

## Motion

Subtle motion is required for both console and marketing. Follow the shared
[motion direction](motion.md), using built-in transitions and CSS first.

## Verified current code

- Console: Next.js ^16.3.5, React ^19.2.7, Eve 0.60.1 (locally patched).
- Chat.tsx uses useEveAgent from eve/react, with a same-origin authenticated proxy.
- AI SDK provider packages are in agent-kit; the lockfile includes ai 7.0.106.
  The console does not directly depend on @ai-sdk/react/useChat.
- Current console package has no shadcn/ui or Tailwind setup; CSS is handwritten.
- ChatTranscript renders model/tool content as escaped plain text deliberately.
- Eve owns send/steer/reset/respond behaviour, input requests and event metadata.

Evidence: services/console/package.json, components/Chat.tsx,
components/ChatTranscript.tsx, app/api/chat/[name]/[...path]/route.ts,
packages/agent-kit/package.json, pnpm-lock.yaml.

## Accepted choices and deferred options

| Choice | Recommendation | Integration notes |
| --- | --- | --- |
| Next.js / React | Keep | Existing routing/server rendering foundation |
| shadcn/ui | Adopt selected components | Sidebar, Button, Field/Input, Select, Tabs, Table, Dropdown Menu, Alert Dialog, Sheet, Skeleton and status feedback; own and theme copied source |
| Tailwind CSS 4 | Adopt with the UI foundation | Required by current AI Elements setup; map Lares tokens and assess reset/preflight impact on existing pages |
| AI Elements | Pilot selected chat components | Conversation, Message shell, Prompt Input and tool status presentation; adapt to Eve rather than copying useChat examples |
| Streamdown | Evaluate for assistant prose | Powers AI Elements MessageResponse; supports streaming Markdown. Keep approval data explicit and escaped; review link/image/HTML handling before replacing current plain text rendering |
| SWR | Optional when live dashboard data needs it | Client refresh/caching for health, counts, usage; retain server rendering for initial loads and Eve for chat streams |
| Vercel chatbot template | Reference only | Whole application starter; adopting it wholesale would duplicate existing auth, persistence and agent behaviour |
| Chat SDK | Defer | Multi-platform bot/channel integration, not the browser conversation component layer; overlaps Eve channel responsibilities |
| Workflow SDK | Defer | No concrete new durability requirement in this UI pass; scheduling/runtime design is separate |
| json-render | Defer | Generative UI is unnecessary for predictable management and approval screens |
| Turborepo | Defer | Build-system optimisation is not a prerequisite for this console restructuring |

Agreed layering: Lares tokens > shadcn primitives > Lares product components;
selected AI Elements presentation > small Eve mapping layer > existing Eve runtime.
This is source/docs-based fit assessment, not a compiled compatibility proof.

## Compatibility proof before broad implementation

Build one real agent editor section and one real chat view in the isolated worktree.
Pin component/package versions; choose one primitive family consistently and inspect
peer dependencies against the installed Eve/AI SDK versions. Avoid accidental runtime
upgrades when adding UI dependencies. Review licences/notices of selected versions.
Verify send, streaming, reconnect, new conversation, steering, approval response,
expiry and duplicate-click handling. Preserve the same-origin authenticated proxy.
Do not copy AI Elements example streamText routes or introduce a second chat owner.
Check Lares fonts, spacing, tokens, focus, dark mode and mobile presentation.
Check existing pages for Tailwind reset regressions. The goal is Lares's visual
language with reusable behaviours; adopting shadcn does not approve its default theme.

The libraries above do not by themselves require moving the self-hosted console to
Vercel hosting. Keep deployment and provider choices separate from UI reuse.

## Sources checked

- https://vercel.com/oss
- https://ui.shadcn.com/docs/installation/next
- https://ui.shadcn.com/docs/components/base/sidebar
- https://elements.ai-sdk.dev/docs/setup
- https://elements.ai-sdk.dev/components/conversation
- https://elements.ai-sdk.dev/components/message
- https://github.com/vercel/streamdown
- https://github.com/vercel/swr
- https://github.com/vercel/chatbot
- https://vercel.com/chat
- https://github.com/vercel/eve


## Preview checkpoint — 2026-09-25

Console-first portable HTML now includes marketing, original color tokens, embedded
Instrument Sans / DM Mono, shadcn/ui controls, AI Elements Conversation, and motion.
Five DOM journey tests and the production preview build pass. Eve integration and
browser visual review remain unverified; this is a sample-state UI preview.
