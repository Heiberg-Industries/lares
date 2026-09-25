'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { capture } from '../lib/analytics';
const ORIGIN = 'https://booking.lares.is';
const APPOINTMENT = 'walkthrough';
const enabled = process.env.NEXT_PUBLIC_BOOKING_ENABLED === 'true';
const BookingContext = createContext<(placement: string) => void>(() => {});
export function BookingProvider({ children }: { children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const script = useRef<HTMLScriptElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const pending = useRef('');
  useEffect(() => {
    let overlay: Element | null = null;
    let completed = false;
    const observer = new MutationObserver(() => {
      const current = document.querySelector('[data-orbis-overlay]');
      if (current && current !== overlay) { overlay = current; completed = false; current.setAttribute('role','dialog'); current.setAttribute('aria-modal','true'); current.setAttribute('aria-label','Book a Lares walkthrough'); document.body.style.overflow = 'hidden'; (current.querySelector('button') as HTMLButtonElement)?.focus(); }
      else if (!current && overlay) { overlay = null; document.body.style.overflow = ''; opener.current?.focus(); capture('booking_closed', { appointment: APPOINTMENT, action: completed ? 'completed' : 'dismissed' }); }
    });
    observer.observe(document.body, { childList: true });
    const message = (e: MessageEvent) => {
      const frame = document.querySelector<HTMLIFrameElement>('[data-orbis-overlay] iframe');
      if (e.origin !== ORIGIN || !frame || e.source !== frame.contentWindow || e.data?.type !== 'orbis:complete' || completed) return;
      completed = true; capture('booking_completed', { appointment: APPOINTMENT });
    };
    window.addEventListener('message', message);
    return () => { observer.disconnect(); window.removeEventListener('message', message); document.body.style.overflow = ''; };
  }, []);
  function open(placement: string) {
    setFailed(false);
    opener.current = document.activeElement as HTMLElement;
    pending.current = placement;
    if (!enabled) { setFailed(true); capture('booking_failed', { action: 'not_configured', placement }); return; }
    function show() { setLoading(false); trigger.current?.click(); capture('booking_opened', { appointment: APPOINTMENT, placement: pending.current }); }
    if (trigger.current?.dataset.orbisWired) { show(); return; }
    if (script.current) return;
    setLoading(true);
    const el = document.createElement('script');
    el.src = `${ORIGIN}/embed.js`; el.async = true;
    const fail = () => { clearTimeout(timeout); el.onload = null; el.onerror = null; script.current = null; el.remove(); setFailed(true); setLoading(false); capture('booking_failed', { action: 'load_error', placement }); };
    const timeout = window.setTimeout(fail, 15000);
    el.onload = () => { clearTimeout(timeout); if (trigger.current?.dataset.orbisWired) show(); else fail(); };
    el.onerror = fail;
    script.current = el; document.body.appendChild(el);
  }
  return <BookingContext.Provider value={open}>
    {children}
    <button hidden ref={trigger} data-orbis-booking-popup={APPOINTMENT} tabIndex={-1} aria-hidden="true" />
    {loading && <p className="booking-notice" role="status">Opening the calendar…</p>}
    {failed && <aside className="booking-notice" role="status">The calendar is not available here yet. <a href="mailto:bendik@heiberg.co?subject=Lares%20walkthrough">Email Bendik to arrange a walkthrough.</a> <button aria-label="Dismiss booking notice" onClick={() => setFailed(false)}>×</button></aside>}
  </BookingContext.Provider>;
}
export function BookingButton({ children, className, placement }: { children: ReactNode; className?: string; placement: string }) {
  const open = useContext(BookingContext);
  return <button type="button" className={className} data-analytics-action="booking" data-analytics-placement={placement} onClick={() => open(placement)}>{children}</button>;
}
