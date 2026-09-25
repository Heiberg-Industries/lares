# Lares marketing, docs and launch

Owner decisions: 2026-09-25. Canonical domain: **lares.is** (www redirects to apex). Lares.sh was not purchased. Keep lares.heiberg.co DNS for later reuse. No signup or waitlist. Keep contact, GitHub and intentional Familia copy. Remove the coming badge. Appointment: **Lares walkthrough, 30 minutes**, using the existing Heiberg calendar.

## Implemented candidate

Isolated Lares branch `codex/marketing-docs-booking`, based on main `166613e`. The protected checkout is unchanged. PR #29 and #20 remain drafts; LAR-50 remains open. No launch, booking activation or DNS write is implied by this implementation.

- Screenshot corrections: group header tools beside right-aligned nav; restore compact theme icon and edge-aligned motion control; correct console-example role symbols, full-width identity row, quiet attention text and review-button surface; remove resting card-link underlines; restore the secondary card gradient.
- Fumadocs at `/docs/`, using the same packages as Orakel with Lares tokens. Five curated starter pages; sidebar, on-page contents, static search and mobile navigation. Do not automatically expose internal repo documents. Marketing copy otherwise retained.
- Public domain metadata, sitemap, robots and icon. Indexing stays disabled until `NEXT_PUBLIC_SITE_INDEXABLE=true` is supplied at build time.
- Static export and unprivileged Nginx Dockerfile, port 8080. CI builds a preview artifact and container; it never pushes an image or deploys from a PR.

## PostHog EU

Existing project: https://eu.posthog.com/project/250457
Dashboard: https://eu.posthog.com/project/250457/dashboard/975526

Nine saved insights cover site/docs visits, pages, referrers, campaigns, actions, section reach, reading depth, docs search and booking journey. Queries validated against the empty prelaunch project. These measure consenting visitors, not total traffic. No fabricated traffic or synthetic conversion events were sent.

Browser SDK loads only after opt-in on `lares.is` or `www.lares.is`. Local and preview traffic is excluded. Withdrawal stops capture. No automatic event/form capture, session replay, identity profiles or self-hosted console instrumentation. A property allowlist strips query strings, initial URLs, form fields and booking identifiers. Campaign values are restricted labels, and referrers are domain-only.

| Event | Purpose / properties |
| --- | --- |
| `$pageview` | Route, marketing/docs surface, referring domain, safe campaign labels |
| `marketing_action` | GitHub, contact/email, docs/navigation, booking CTA; placement where defined |
| `section_viewed` | Section reached once per page visit |
| `reading_progress` | 25/50/75/100 percent of scrollable page, once per visit |
| `docs_search_used` | Search use; no query text |
| `docs_search_result_clicked` | Mouse or keyboard result selection; no typed text |
| `docs_code_copied` | Copy control use when a docs page includes a code block |
| `booking_opened` | Actual popup opening; appointment and CTA placement |
| `booking_completed` | Exact booking-origin + active iframe completion message; no booking ID or form data |
| `booking_closed`, `booking_failed` | Dismissal/completion or load/configuration failure |
| `appearance_changed`, `hero_motion_changed` | Theme and motion interactions |

Consent uses the shared c15t service at `https://consent.heiberg.co/api`. The banner is ported from Orakel, with Lares colors, fonts and radii. Categories are Necessary and Analytics (`measurement`); PostHog requires a saved Analytics choice. The superseded local-only preference is ignored. Footer preferences and privacy documentation are included. Public ingestion token is a build setting, not a private management credential. The local ignored `.env.local` is configured; CI/production must receive the public token separately. Project settings (timezone etc.) have not been changed.

## Booking dependency and rollout

Heiberg uses `embed.js` plus `data-orbis-booking-popup`. Lares reuses that exact loader, including the 480px desktop window, mobile sheet and close behavior. It is loaded on demand, with a persistent trigger across page navigation. Until the service is ready, `NEXT_PUBLIC_BOOKING_ENABLED=false` presents an email fallback.

Prepared separately in Orbis branch `codex/lares-booking`:

- `booking.lares.is` maps to Lares and permits framing only by `https://lares.is` and `https://www.lares.is`.
- Self-hosted Instrument Sans in the booking font set.
- `services/booking/scripts/prepare-lares.ts`: default read-only check; `--apply` creates only a new **draft** Lares brand/appointment. It refuses to overwrite an existing brand. Copies current office hours, notice, buffer and horizon from Heiberg intro, and uses the same connected calendar. Does not create a new calendar or appointment invitation.

Launch order after approval:

1. Review and merge the two candidates; deploy the Lares domain entry in the shared consent service and run `services/website/tests/live/consent.live.mts` (read-only CORS and initialization gate); build booking and website images in CI, record their immutable digests. Check Orbis capacity and current Coolify routing before applying changes.
2. Add `booking.lares.is` DNS to the same existing server; configure its hostname/TLS on the existing booking application. Apex/www A records are already present and were verified on 2026-09-25.
3. Deploy the booking candidate; run the Lares-only provisioning check, then explicitly apply the draft. Review the Lares theme and scheduling policy in admin and activate the walkthrough.
4. Verify live headers, the compact popup and the Heiberg calendar binding. A real test booking/invitation is a separate explicitly authorized action.
5. Build website with PostHog project token and booking enabled. Deploy its image digest as a separate Coolify application on port 8080, with `https://lares.is` and www-to-apex redirect. Configure TLS. Set indexing true only for public launch.
6. Verify homepage/docs/search, consent/withdrawal, PostHog real-event arrival, booking, redirects, sitemap and Search Console domain verification.

Rollback: restore previous website/booking image digests. The new booking brand can be returned to draft. Do not change Heiberg intro or remove lares.heiberg.co DNS. No new server is required for this plan.

## Evidence and remaining boundaries

Local website build/typecheck and eight analytics privacy tests pass. Browser review includes desktop and 390px marketing/docs, light and dark, search and navigation. Booking host/embed tests pass (13). Local Docker image built successfully; the running nginx container returned 200 for docs and search, and 404 for an unknown route. No image was published.

No production image published or service deployed. Booking draft script has not run against a database. PostHog dashboard exists, but live ingestion is unproved until deployment. Read-only Orbis capacity check on 2026-09-25 found 2.5 GiB available RAM, 29 GiB free disk and low load; the static nginx site fits. Google Search Console verification, TLS/routing and real calendar behavior remain launch checks. The deleted Hetzner test server has not been recreated.

## Shared consent follow-up (2026-09-25)

Owner requested the portfolio consent service and Orakel banner design. Orbis PR #13 includes `lares.is` and `www.lares.is` in the consent tenant map; no preview origins are added. Three tenant tests cover exact domains, rejected lookalikes and preserved existing attribution. Live OPTIONS currently omits allow-origin for Lares, so the service update remains necessary. Existing Heiberg `/api/init` returns 200 with GDPR opt-in. The website uses the same c15t 2.1.0 client versions declared by Orakel.

Current live consent image is based on `50747ca0`; current booking image on `d87456f1`. Existing Coolify services build from source, so changing them to a CI-built immutable image needs an explicit rollout configuration. No service, DNS or database mutations were made during this follow-up.
