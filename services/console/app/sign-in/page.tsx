import { DoorLayout } from "../../components/DoorLayout";
import { signedInMember, isConsoleOwner, members } from "../../lib/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeNext } from "../../lib/safe-next";
import { consoleRedirect } from "../../lib/console-oidc";
import { OWNER_DISCOVERY_COOKIE, openOwnerDiscoveryReceipt } from "../../lib/owner-bootstrap-receipt";
import { Field, FieldGroup, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
import styles from "./sign-in.module.css";

export const metadata = { title: "Sign in to Lares" };

const ERRORS: Record<string, string> = {
  denied: "That account is not allowed to use this console. Ask the owner for an invitation.",
  failed: "Sign-in did not finish. Try again.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const member = await signedInMember();
  if (member) redirect(isConsoleOwner(member) ? safeNext(q.next) : "/your-membership");
  const receipt = await openOwnerDiscoveryReceipt((await cookies()).get(OWNER_DISCOVERY_COOKIE)?.value);
  const ownerId = process.env.AGENT_OWNER_USER_ID?.trim();
  const originMatches = !!receipt && receipt.installationOrigin === new URL(consoleRedirect()).origin;
  const owner = originMatches && ownerId ? await members.currentMember(ownerId) : undefined;
  const showOwnerSetup = !!receipt && originMatches && !!owner && isConsoleOwner(owner) &&
    await members.firstOwnerBootstrapEligible(ownerId!, owner.organisationId);
  const next = safeNext(q.next);
  const error = typeof q.error === "string" ? (ERRORS[q.error] ?? ERRORS.failed) : null;
  const signedOut = !error && q["signed-out"] !== undefined;
  const loginHref = next === "/" ? "/api/auth/login" : `/api/auth/login?next=${encodeURIComponent(next)}`;
  return (
    <DoorLayout>
      <h1 className={styles.title}>Sign in to Lares</h1>
      {error && <Notice error>{error}</Notice>}
      {signedOut && <Notice>You&apos;re signed out.</Notice>}
      {showOwnerSetup && receipt && <Card>
        <CardHeader>
          <CardTitle id="owner-setup-title" role="heading" aria-level={2}>Confirm this first-owner sign-in</CardTitle>
        </CardHeader>
        <CardContent className="lares-stack" role="group" aria-labelledby="owner-setup-title">
          <p>This verified provider account can be linked to the first owner on this fresh installation. Confirm that the installation origin below is yours. On the installing server, run <code>sudo lares owner-bootstrap</code> and paste the JSON below at its protected prompt. Then recreate only Console and sign in again with this same account. This display expires in five minutes.</p>
          <pre className={`mono ${styles.ownerSetupDetails}`} aria-label="Owner setup JSON">{JSON.stringify(receipt)}</pre>
          <p>The setup details do not sign you in. A new provider check is required after the server confirms them.</p>
        </CardContent>
      </Card>}
      <Button asChild className={styles.wide}>
        <a href={loginHref}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h5.9a5.04 5.04 0 0 1-2.19 3.31v2.75h3.55c2.08-1.91 3.24-4.74 3.24-8.3z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.55-2.75c-.98.66-2.24 1.06-3.73 1.06-2.87 0-5.3-1.94-6.17-4.55H2.17v2.84A11 11 0 0 0 12 23z" />
            <path fill="#FBBC05" d="M5.83 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.17a11 11 0 0 0 0 9.88l3.66-2.84z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.17 7.06l3.66 2.84C6.7 7.32 9.13 5.38 12 5.38z" />
          </svg>
          Continue with Google
        </a>
      </Button>
      <Button asChild variant="outline" className={styles.wide}>
        <a href={`/api/auth/login?provider=microsoft&next=${encodeURIComponent(next)}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
            <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
            <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
            <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
          </svg>
          Continue with Microsoft 365 work account
        </a>
      </Button>
      <p className={styles.divider} aria-hidden="true">or</p>
      <form aria-describedby="sign-in-soon">
        <FieldGroup legend="Sign in with email" disabled>
          <Field label="Email">
            <Input type="email" name="email" autoComplete="email" placeholder="you@example.com" disabled aria-describedby="sign-in-soon" />
          </Field>
          <Field label="Password">
            <Input type="password" name="password" autoComplete="current-password" disabled aria-describedby="sign-in-soon" />
          </Field>
          <Button type="submit" variant="outline" className={styles.wide} disabled>Sign in</Button>
          <Button type="button" variant="ghost" className={styles.wide} disabled>Email me a sign-in link</Button>
        </FieldGroup>
      </form>
      <p className={styles.note} id="sign-in-soon">Email sign-in is coming soon. Continue with Google or a configured Microsoft 365 work account. Sign-in does not connect your mailbox or calendar.</p>
    </DoorLayout>
  );
}
