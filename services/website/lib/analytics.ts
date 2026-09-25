import type { PostHog } from 'posthog-js';
export const CONSENT_KEY = 'lares-marketing-analytics';
export const ANALYTICS_EVENTS = new Set(['$pageview', 'marketing_action', 'section_viewed', 'reading_progress', 'docs_search_used', 'docs_search_result_clicked', 'docs_code_copied', 'booking_opened', 'booking_completed', 'booking_closed', 'booking_failed', 'appearance_changed', 'hero_motion_changed']);
let client: PostHog | undefined;
let allowed = false;
let generation = 0;
export function capture(event: string, properties: Record<string, string | number | boolean> = {}) {
  if (!allowed || !client || !ANALYTICS_EVENTS.has(event)) return;
  client.capture(event, { ...properties, path: location.pathname, surface: location.pathname.startsWith('/docs') ? 'docs' : 'marketing' });
}
export function sanitizeProperties(properties: Record<string, unknown>) {
  const names = new Set(['token', 'distinct_id', '$session_id', '$window_id', '$device_id', '$lib', '$lib_version', '$browser', '$browser_version', '$os', '$os_version', '$device_type', '$screen_height', '$screen_width', '$viewport_height', '$viewport_width', '$is_identified', '$process_person_profile', '$insert_id', 'path', 'surface', 'action', 'placement', 'target', 'section', 'percent', 'appearance', 'paused', 'appointment', 'referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign', '$current_url', '$pathname', '$host', '$title', '$referring_domain']);
  return Object.fromEntries(Object.entries(properties).filter(([k]) => names.has(k)).map(([k,v]) => {
    if (k === '$current_url' && typeof v === 'string') { try { const u = new URL(v); v = u.origin + u.pathname; } catch { v = ''; } }
    return [k,v];
  }));
}
export async function setAnalyticsConsent(accept: boolean) {
  const current = ++generation;
  allowed = accept;
  if (!accept) { client?.opt_out_capturing(); client?.reset(); return; }
  const token = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  // Local development and previews never ingest into the production project.
  if (!token || !['lares.is', 'www.lares.is'].includes(location.hostname)) return;
  if (!client) {
    const { default: posthog } = await import('posthog-js');
    if (current !== generation || !allowed) return;
    posthog.init(token, {
      api_host: 'https://eu.i.posthog.com', ui_host: 'https://eu.posthog.com',
      autocapture: false, capture_pageview: false, capture_pageleave: false,
      disable_session_recording: true, disable_surveys: true,
      capture_exceptions: false, capture_performance: false, rageclick: false,
      person_profiles: 'identified_only', opt_out_capturing_by_default: true,
      persistence: 'localStorage', cross_subdomain_cookie: false,
      advanced_disable_feature_flags: true,
      before_send: (event) => {
        if (!allowed || !event || !ANALYTICS_EVENTS.has(event.event)) return null;
        event.properties = sanitizeProperties(event.properties);
        return event;
      },
    });
    client = posthog;
  }
  client.opt_in_capturing({ captureEventName: false });
}
export function pageview() {
  let referrer = '';
  try { referrer = document.referrer ? new URL(document.referrer).hostname : ''; } catch {}
  const props: Record<string, string> = { referrer_domain: referrer, $current_url: location.origin + location.pathname };
  const query = new URLSearchParams(location.search);
  // Campaign labels only; no arbitrary query text or identifiers.
  for (const key of ['utm_source','utm_medium','utm_campaign']) {
    const value = query.get(key);
    if (value && /^[a-zA-Z0-9_. -]{1,80}$/.test(value)) props[key] = value;
  }
  capture('$pageview', props);
}
