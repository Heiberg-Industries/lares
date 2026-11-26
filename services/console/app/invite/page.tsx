import { safeNext } from "../../lib/safe-next";
import { DoorLayout } from "../../components/DoorLayout";
import { Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import styles from "../sign-in/sign-in.module.css";
export const dynamic = "force-dynamic";
export default async function InvitationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await searchParams;
  const valid = typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
  return <DoorLayout><h1 className={styles.title}>Accept your invitation</h1>
    <p className={styles.note}>Continue only if this invitation was shared with you. Sign-in binds your provider identity to the invited member record. It does not connect a mailbox or calendar.</p>
    {valid ? <><Button asChild className={styles.wide}><a href={`/api/auth/login?provider=google&invite=${encodeURIComponent(token)}&next=${encodeURIComponent(safeNext('/your-membership'))}`}>Continue with Google</a></Button>
      <Button asChild variant="outline" className={styles.wide}><a href={`/api/auth/login?provider=microsoft&invite=${encodeURIComponent(token)}&next=%2Fyour-membership`}>Continue with Microsoft 365 work account</a></Button></> : <Notice error>This invitation link is not valid. Ask the owner for a new one.</Notice>}
  </DoorLayout>;
}
