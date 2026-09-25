'use client';
import { useEffect } from 'react';
import { ConsentDialogLink, useConsentManager } from '@c15t/nextjs';
import { usePathname } from 'next/navigation';
import { capture, pageview, setAnalyticsConsent } from '../lib/analytics';
export function Analytics() {
  const path = usePathname();
  const store = useConsentManager();
  const hasConsent = store.hasConsented() && store.has('measurement');
  useEffect(() => {
    if (!hasConsent) void setAnalyticsConsent(false);
  }, [hasConsent]);
  useEffect(() => {
    if (!hasConsent) return;
    let active = true;
    // Wait for the SDK before observing initial section impressions.
    void setAnalyticsConsent(true).then(() => {
      if (!active) return;
      pageview();
      document.querySelectorAll('main section[id], #contact, #product').forEach(el => observer.observe(el));
      scroll();
    });
    const seen = new Set<string>();
    let searched = false;
    const click = (e: MouseEvent) => {
      const node = e.target instanceof Element ? e.target : null;
      if (path.startsWith('/docs') && node?.closest('[role="dialog"] button[aria-selected]')) capture('docs_search_result_clicked');
      const explicit = node?.closest<HTMLElement>('[data-analytics-action]');
      if (explicit) capture('marketing_action', { action: explicit.dataset.analyticsAction!, placement: explicit.dataset.analyticsPlacement || 'page' });
      const a = node?.closest<HTMLAnchorElement>('a[href]');
      if (a && !explicit) {
        const u = new URL(a.href, location.href);
        const docsSearch = !!a.closest('[role="dialog"]');
        capture(docsSearch ? 'docs_search_result_clicked' : 'marketing_action', { action: u.hostname === 'github.com' ? 'github' : u.protocol === 'mailto:' ? 'email' : u.pathname.startsWith('/docs') ? 'docs' : 'navigation', target: u.origin === location.origin ? u.pathname + u.hash : u.hostname, placement: path.startsWith('/docs') ? 'docs' : 'page' });
      }
      if (path.startsWith('/docs') && node?.closest('button[aria-label="Copy Text"], button[aria-label="Copy text"], button[aria-label="Copy code"]')) capture('docs_code_copied');
    };
    const input = (e: Event) => {
      const el = e.target;
      if (!searched && el instanceof HTMLInputElement && el.closest('[role="dialog"]') && el.value.trim()) { searched = true; capture('docs_search_used'); }
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.closest('[role="dialog"]')?.querySelector('button[aria-selected="true"]')) capture('docs_search_result_clicked');
    };
    const scroll = () => {
      const available = document.documentElement.scrollHeight - innerHeight;
      if (available <= 0) return;
      const percent = Math.min(100, Math.round(scrollY / available * 100));
      for (const milestone of [25,50,75,100]) if (percent >= milestone && !seen.has(`scroll-${milestone}`)) { seen.add(`scroll-${milestone}`); capture('reading_progress', { percent: milestone }); }
    };
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      const id = entry.target.id;
      if (entry.isIntersecting && !seen.has(id)) { seen.add(id); capture('section_viewed', { section: id }); }
    }), { threshold: 0.2 });
    document.addEventListener('keydown', keydown); document.addEventListener('click', click); document.addEventListener('input', input); window.addEventListener('scroll', scroll, { passive: true });
    return () => { active = false; observer.disconnect(); document.removeEventListener('keydown', keydown); document.removeEventListener('click', click); document.removeEventListener('input', input); window.removeEventListener('scroll', scroll); };
  }, [path, hasConsent]);
  return <ConsentDialogLink className="analytics-preferences">Analytics preferences</ConsentDialogLink>;
}
