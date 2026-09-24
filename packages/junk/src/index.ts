/**
 * Junk / automated-sender classification — shared across Lares services.
 *
 * Extracted per ADR-0007 (docs/decisions/0007-shared-ts-packages-github-packages.md),
 * Task 5. Before this package, the same email-shape heuristics existed as three
 * drifting copies: services/network/lib/twenty-cleanup.ts (original),
 * services/agent-runtime/lib/commercial/junk.ts (a ported copy with additions),
 * and services/agent-runtime/lib/adapters/junk-sender.ts (a separately-evolved
 * two-class classifier). This module is the single source of truth for both
 * lineages that survived the merge:
 *
 *   1. isJunkEmail(email) — regex-only local part / domain check. Used to gate
 *      Twenty-record cleanup (auto-synced Person records that look transactional)
 *      and as the email half of the radar's contact classifier. JUNK_LOCALPART
 *      here is the union of the two prior copies (twenty-cleanup.ts's original
 *      plus the reservation/resepsjon/office tokens commercial/junk.ts had added
 *      for the booking-confirmation / generic-inbox case) — a strict superset,
 *      so consuming it changes no existing "junk" verdict, only adds a few.
 *
 *   2. classifySender(from) — the two-class STRICT/GENERIC localpart split +
 *      VENDOR_DOMAINS/PERSONAL_DOMAINS sets from junk-sender.ts (the newest,
 *      most-evolved logic — it exists specifically to avoid the false positives
 *      a naive single-class regex produces on real human addresses like
 *      "team.lead.hansen@firma.no"). Used for inbound-email triage, where a
 *      wrong "automated" verdict silently drops a human's message.
 *
 * Both lineages are kept distinct (not merged into one function) because they
 * answer different questions at different confidence bars: isJunkEmail is a
 * blunt regex used only alongside other conservative gates (source, curation,
 * relationship signals) elsewhere; classifySender's whole point is precision on
 * its own.
 */

// ---------------------------------------------------------------------------
// Lineage 1: isJunkEmail — Twenty-record / contact classification.
// ---------------------------------------------------------------------------

/** Transactional / non-human local parts (the bit before "@"). */
export const JUNK_LOCALPART =
  /^(no[._-]?reply|donotreply|do[._-]?not[._-]?reply|unsub(scribe)?|newsletter|news|nyhetsbrev|notifications?|varsel|varsling|mailer|mailing|order[s]?|ordre|receipt[s]?|kvittering|invoice[s]?|faktura|billing|payments?|marketing|markedsforing|updates?|alert[s]?|automated|auto|bounce|postmaster|notify|digest|support|kundeservice|kundestotte|hello|hei|info|kontakt|team|contact|members?|community|hq|press|presse|jobs?|careers?|recruit|booking|hr|salg|sales|post|admin|webmaster|reservation|resepsjon|office)([._+-]|$)/i;

/** Known newsletter / ESP / transactional sending domains (and common sub-domain prefixes). */
export const JUNK_DOMAIN =
  /@(.*\.)?(substack|mailchimp|mailchimpapp|sendgrid|mailgun|sparkpostmail|hubspot|klaviyo|klaviyomail|customer\.io|intercom-mail|intercom|sendinblue|brevo|mailerlite|convertkit|beehiiv|ghost|campaign-archive|socialboards|formitable|easytablebooking|ridewithgps)\.|@(e|email|mail|news|nyhetsbrev|info|notifications?|reply|noreply|no-reply|t|m|mg|send|mailing|marketing|shared)\./i;

export function isJunkEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at);
  if (JUNK_LOCALPART.test(local)) return true;
  if (JUNK_DOMAIN.test(email)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Lineage 2: classifySender — inbound-email sender triage.
// ---------------------------------------------------------------------------

// Localpart keywords come in two classes with different match strictness:
// - STRICT: tokens that never appear in a human's address (noreply, mailer-daemon,
//   newsletter, …). Safe to match as any dot/dash/underscore-delimited SEGMENT
//   (catches "noreply-orders", "billing.eu", "acme.newsletter").
// - GENERIC: ordinary words that show up in real corporate human addresses
//   ("team.lead.hansen@", "hr.director@", "kari.info@"). Only automated when the
//   word IS the entire localpart (booking@hotel.no yes, office.manager.olsen@ no).
const STRICT_LOCALPART =
  /(^|[.\-_+])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|automated|mailer|newsletter|digest|receipts?|invoices?|billing|order-update)([.\-_+]|$)/i;

const GENERIC_LOCALPART =
  /^(team|office|hr|info|kontakt|contact|admin|support|help|hello|hei|jobs|careers|marketing|updates?|news|booking|reservation|resepsjon|orders?)$/i;

export const VENDOR_DOMAINS = new Set([
  "airbnb.com", "linkedin.com", "facebookmail.com", "slack.com", "github.com",
  "google.com", "youtube.com", "medium.com", "substack.com", "mailchimp.com",
  "sendgrid.net", "klaviyo.com", "intercom.io", "stripe.com", "paypal.com",
  "booking.com", "hotels.com", "tripadvisor.com", "finn.no", "vy.no", "sas.se",
]);

// Personal-mail domains are never vendor domains, and a keyword-ish localpart there
// (e.g. "info.andersen@gmail.com") is very likely just a person's own naming choice,
// not a transactional sender. Exempt them from the localpart check entirely — when in
// doubt, "unknown" and let the LLM triage decide.
export const PERSONAL_DOMAINS = new Set([
  "gmail.com", "hotmail.com", "icloud.com", "outlook.com", "yahoo.com", "me.com", "live.com",
]);

function extractAddr(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

export function classifySender(from: string): "automated" | "unknown" {
  const addr = extractAddr(from);
  const at = addr.lastIndexOf("@");
  if (at < 0) return "unknown";
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  // NOTE: naive last-two-labels base domain — mishandles multi-label public suffixes
  // (.co.uk → "co.uk"). Harmless today: no such entry exists in either domain set.
  // Add real public-suffix handling only if one is ever added.
  const baseDomain = domain.split(".").slice(-2).join(".");
  if (VENDOR_DOMAINS.has(domain) || VENDOR_DOMAINS.has(baseDomain)) return "automated";
  if (PERSONAL_DOMAINS.has(baseDomain)) return "unknown";
  if (STRICT_LOCALPART.test(local) || GENERIC_LOCALPART.test(local)) return "automated";
  return "unknown";
}
