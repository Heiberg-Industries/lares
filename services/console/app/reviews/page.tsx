import { actingAddress, mayUse, requirePage } from "../../lib/auth";
import { PageHeader, Page } from "@lares/ui/patterns";
import { listWaiting } from "../../lib/waiting";
import { waitingDeps } from "../../lib/waiting-deps";
import { decide } from "../actions/waiting";
import { WaitingList } from "../../components/WaitingList";

export const dynamic = "force-dynamic";

/**
 * Reviews — every approval an agent is waiting on, whichever conversation it was asked in,
 * with the whole of what would be done and the buttons to decide it. A Telegram card too long for
 * one message links here (`?request=<id>` opens that one). Only the owner of an agent sees its items
 * (`lib/waiting.ts`).
 */
export default async function WaitingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const person = await requirePage("admin");
  const member = await actingAddress("admin");
  if (!member) throw new Error("unauthenticated");
  const [{ request }, list] = await Promise.all([searchParams, listWaiting(member, waitingDeps)]);
  return (
    <Page>
      <PageHeader
        title="Reviews"
        description="Everything your agents are waiting for you to approve or reject."
      />
      <WaitingList
        items={list.items}
        unreadable={list.unreadable}
        now={Date.now()}
        onDecide={decide}
        {...(mayUse(person, "owner") ? {} : { emptyNote: "Approvals are answered by each agent's owner, so there is nothing here for you to decide." })}
        {...(typeof request === "string" ? { selectedRef: request } : {})}
      />
    </Page>
  );
}
