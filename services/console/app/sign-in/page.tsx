import { signedInMember, isConsoleOwner } from "../../lib/auth";
import { redirect } from "next/navigation";
import { Mark } from "@lares/ui/patterns";
import { safeNext } from "../../lib/safe-next";
import styles from "./sign-in.module.css";

export const metadata = { title: "Sign in to Lares" };

const ERRORS: Record<string, string> = {
  denied: "That account is not allowed to use this console. Ask the owner for an invitation.",
  failed: "Sign-in did not finish. Try again.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const member = await signedInMember();
  if (member) redirect(isConsoleOwner(member) ? safeNext(q.next) : "/membership");
  const next = safeNext(q.next);
  const error = typeof q.error === "string" ? (ERRORS[q.error] ?? ERRORS.failed) : null;
  const signedOut = !error && q["signed-out"] !== undefined;
  const loginHref = next === "/" ? "/api/auth/login" : `/api/auth/login?next=${encodeURIComponent(next)}`;
  return (
    <div className={styles.page}>
      <section className={styles.panel} aria-label="About Lares">
        <div className={`${styles.light} ${styles.lightOne}`} aria-hidden="true" />
        <div className={`${styles.light} ${styles.lightTwo}`} aria-hidden="true" />
        <svg className={styles.grain} aria-hidden="true">
          <filter id="sign-in-grain">
            <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#sign-in-grain)" />
        </svg>
        <div className={styles.brand}><Mark />Lares</div>
        <div className={styles.message}>
          <h2 className={styles.headline}>Your agents. Your server.</h2>
          <p className={styles.lead}>Lares runs the day-to-day of your business on a machine you control. Nothing leaves it unless you say so.</p>
        </div>
      </section>
      <main className={styles.side} id="main-content">
        <div className={styles.card}>
          <h1 className={styles.title}>Sign in to Lares</h1>
          {error && <p className={`${styles.notice} ${styles.error}`} role="alert">{error}</p>}
          {signedOut && <p className={styles.notice} role="status">You&apos;re signed out.</p>}
          <a className={`${styles.button} ${styles.primary}`} href={loginHref}>
            <svg className={styles.googleG} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h5.9a5.04 5.04 0 0 1-2.19 3.31v2.75h3.55c2.08-1.91 3.24-4.74 3.24-8.3z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.55-2.75c-.98.66-2.24 1.06-3.73 1.06-2.87 0-5.3-1.94-6.17-4.55H2.17v2.84A11 11 0 0 0 12 23z" />
              <path fill="#FBBC05" d="M5.83 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.17a11 11 0 0 0 0 9.88l3.66-2.84z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.17 7.06l3.66 2.84C6.7 7.32 9.13 5.38 12 5.38z" />
            </svg>
            Continue with Google
          </a>
          <a className={styles.button} href={`/api/auth/login?provider=microsoft&next=${encodeURIComponent(next)}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
              <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
              <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
              <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
            </svg>
            Continue with Microsoft 365 work account
          </a>
          <p className={styles.divider} aria-hidden="true">or</p>
          <form aria-describedby="sign-in-soon">
            <fieldset className={styles.email} disabled aria-disabled="true">
              <legend className={styles.visuallyHidden}>Sign in with email</legend>
              <label className={styles.field}>Email
                <input className={styles.input} type="email" name="email" autoComplete="email" placeholder="you@example.com" disabled aria-disabled="true" aria-describedby="sign-in-soon" />
              </label>
              <label className={styles.field}>Password
                <input className={styles.input} type="password" name="password" autoComplete="current-password" disabled aria-disabled="true" aria-describedby="sign-in-soon" />
              </label>
              <button type="submit" className={styles.button} disabled aria-disabled="true">Sign in</button>
              <button type="button" className={styles.textButton} disabled aria-disabled="true">Email me a sign-in link</button>
            </fieldset>
          </form>
          <p className={styles.note} id="sign-in-soon">Email sign-in is coming soon. Continue with Google or a configured Microsoft 365 work account. Sign-in does not connect your mailbox or calendar.</p>
        </div>
      </main>
    </div>
  );
}
