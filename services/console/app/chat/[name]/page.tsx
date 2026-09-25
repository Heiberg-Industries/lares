import { listAgents } from "../../../lib/agents";
import { Chat } from "../../../components/Chat";
import { creationNotices } from "../../../lib/first-conversation";
import { verify } from "../../../lib/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ChatAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ created?: string; backup?: string }>;
}) {
  const { name } = await params;
  const owner = await verify((await cookies()).get("lares_session")?.value);
  if (!owner) redirect("/api/auth/login");
  const agents = await listAgents();
  const notice = creationNotices(await searchParams);
  return (
    <>
      {notice.ready && <p role="status">{notice.ready}</p>}
      {notice.backup && <p role="alert">{notice.backup}</p>}
      <Chat
        name={name}
        owner={owner}
        agents={agents.map(({ name, displayName, role }) => ({
          name,
          displayName,
          role,
        }))}
      />
    </>
  );
}
