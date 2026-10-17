import { listAgents } from "../../../lib/agents";
import { Chat } from "../../../components/Chat";
import { creationNotices } from "../../../lib/first-conversation";
import { verify } from "../../../lib/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { InboxPanel } from "../../../components/InboxPanel";
import { getInboxMessage, markInboxRead, readInbox, replySeed } from "../../../lib/web-inbox";

export const dynamic = "force-dynamic";

export default async function ChatAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ created?: string; backup?: string; reply?: string }>;
}) {
  const { name } = await params;
  const owner = await verify((await cookies()).get("lares_session")?.value);
  if (!owner) redirect("/api/auth/login");
  const agents = await listAgents();
  const query = await searchParams;
  const notice = creationNotices(query);
  // "Reply" on a web-chat message: the chat starts from that message, and the message counts as read.
  const replied = query.reply ? await getInboxMessage(name, Number(query.reply)) : null;
  if (replied && !replied.read) await markInboxRead(name, replied.id).catch(() => {});
  const { unread, earlier } = await readInbox(name, { earlier: 5 });
  return (
    <>
      {notice.ready && <p role="status">{notice.ready}</p>}
      {notice.backup && <p role="alert">{notice.backup}</p>}
      <Chat
        name={name}
        owner={owner}
        fresh={notice.ready !== null}
        {...(replied ? { seed: replySeed(replied) } : {})}
        inbox={<InboxPanel agent={name} initial={unread} earlier={earlier} />}
        agents={agents.map(({ name, displayName, role, avatarVersion }) => ({
          name,
          displayName,
          role,
          avatarVersion,
        }))}
      />
    </>
  );
}
