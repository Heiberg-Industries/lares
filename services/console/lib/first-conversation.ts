export function firstChatPath(name: string, backupOk: boolean): string {
  return `/chat/${encodeURIComponent(name)}?created=1${backupOk ? "" : "&backup=failed"}`;
}

export function creationNotices(search: { created?: string; backup?: string }): {
  ready: string | null;
  backup: string | null;
} {
  return {
    ready: search.created === "1"
      ? "Agent created and healthy. Send its first message below."
      : null,
    backup: search.backup === "failed"
      ? "The definition is saved, but its Git backup did not complete. You can chat now; inspect backup status separately."
      : null,
  };
}
