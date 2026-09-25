# Public website analytics and launch decisions

Owner update: 2026-09-25. LAR-11 remains open.

The Lares repository is public. The website has no waitlist or signup. Its contact
section links to `bendik@heiberg.co` for setup enquiries and other messages.

## Analytics

- Use PostHog for public website product/marketing analytics, subject to the
  site's consent and privacy implementation. Keep it out of the self-hosted
  console. No PostHog key or client is wired into the website yet.
- Use Google Search Console for indexing and search performance. Domain ownership
  verification, sitemap, canonical URL and indexing should be configured when the
  final public domain and publication date are agreed. The current website has
  `noindex` metadata while it is a build-only preview.
- GA4, GTM, ad pixels and BigQuery are not part of this decision. Revisit them
  only if there is a concrete need.

## Booking and contact

The existing Orbis booking page at `https://booking.heiberg.co/intro` is backed
by the Heiberg calendar in the Orbis seed configuration. The website currently
links to that page. The Orbis `embed.js` supports a popup, as used on Orakel, but
the live booking response currently allows framing only from `heiberg.co` and
`www.heiberg.co`. A popup on a Lares domain therefore needs an Orbis booking
brand/frame-policy change first. Its current Heiberg look also needs a Lares
theme if the booking experience should match this site. Decide the public Lares
domain and brand configuration before making that cross-repo change.

## Hosting

The owner suggested the existing Orbis box for this low-traffic website. Check
capacity, isolation, deployment path, DNS/TLS and rollback with the Orbis owner
before deployment. No Lares website deployment is configured yet.
