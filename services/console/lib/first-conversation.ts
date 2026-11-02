export function firstChatPath(name: string, backupStatus: "saved" | "disabled" | "failed"): string {
  return `/chat/${encodeURIComponent(name)}?created=1${backupStatus === "saved" ? "" : `&backup=${backupStatus}`}`;
}

/** An agent held for native budget activation has no chat yet; its page says what comes next. */
export function afterCreationPath(name: string, backupStatus: "saved" | "disabled" | "failed", runtimeReason?: string | null): string {
  return runtimeReason === "Native budget activation required" ? `/agents/${encodeURIComponent(name)}` : firstChatPath(name, backupStatus);
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
      : search.backup === "disabled"
        ? "Git definition backup is not enabled. The agent is saved locally; configure and test a server backup before relying on it for data you need to keep."
        : null,
  };
}
