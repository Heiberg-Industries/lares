import { safeNext } from "../../lib/safe-next";
export const dynamic = "force-dynamic";
export default async function InvitationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await searchParams;
  const valid = typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
  return <main className="lares-page lares-stack" id="main-content"><h1>Accept your invitation</h1>
    <p>Continue only if this invitation was shared with you. Sign-in binds your provider identity to the invited member record. It does not connect a mailbox or calendar.</p>
    {valid ? <><a href={`/api/auth/login?provider=google&invite=${encodeURIComponent(token)}&next=${encodeURIComponent(safeNext('/membership'))}`}>Continue with Google</a>
      <a href={`/api/auth/login?provider=microsoft&invite=${encodeURIComponent(token)}&next=%2Fmembership`}>Continue with Microsoft 365 work account</a></> : <p role="alert">This invitation link is not valid. Ask the owner for a new one.</p>}
  </main>;
}
