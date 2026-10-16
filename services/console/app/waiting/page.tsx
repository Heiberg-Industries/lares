import { cookies } from "next/headers";
import { PageHeader } from "@lares/ui/patterns";
import { verify } from "../../lib/auth";
import { listWaiting } from "../../lib/waiting";
import { waitingDeps } from "../../lib/waiting-deps";
import { decide } from "../actions/waiting";
import { WaitingList } from "../../components/WaitingList";

export const dynamic = "force-dynamic";

/**
 * Waiting on you — every approval an agent is waiting on, whichever conversation it was asked in,
 * with the whole of what would be done and the buttons to decide it. A Telegram card too long for
 * one message links here (`?request=<id>` opens that one). Only the owner of an agent sees its items
 * (`lib/waiting.ts`).
 */
export default async function WaitingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const member = await verify((await cookies()).get("lares_session")?.value);
  if (!member) throw new Error("unauthenticated");
  const [{ request }, list] = await Promise.all([searchParams, listWaiting(member, waitingDeps)]);
  return (
    <div className="lares-page lares-stack">
      <PageHeader
        title="Waiting on you"
        description="What your agents have asked you, from every conversation, with everything they would do. Decide here or where it was asked."
      />
      <WaitingList
        items={list.items}
        unreadable={list.unreadable}
        now={Date.now()}
        onDecide={decide}
        {...(typeof request === "string" ? { selectedRef: request } : {})}
      />
    </div>
  );
}
