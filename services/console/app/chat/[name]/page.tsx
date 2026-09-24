import { Chat } from "../../../components/Chat";
import { creationNotices } from "../../../lib/first-conversation";

export const dynamic = "force-dynamic";

export default async function ChatAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ created?: string; backup?: string }>;
}) {
  const { name } = await params;
  const notice = creationNotices(await searchParams);
  return (
    <>
      {notice.ready && <p role="status">{notice.ready}</p>}
      {notice.backup && <p role="alert">{notice.backup}</p>}
      <Chat name={name} />
    </>
  );
}
