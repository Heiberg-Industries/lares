"use client";
/**
 * The dot beside "Chat" in the navigation when an agent has left a message in web chat. Looks when
 * the page opens and every minute while the page is visible; renders nothing when there is nothing
 * unread, or when the answer cannot be had.
 */
import { useEffect, useState } from "react";
import styles from "./AppShell.module.css";

export const DOT_POLL_MS = 60_000;

export function InboxDot() {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const look = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/inbox", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const body = (await res.json()) as { unread?: number };
        if (alive && typeof body.unread === "number") setUnread(body.unread);
      } catch {
        /* keep the last answer */
      }
    };
    void look();
    const timer = window.setInterval(look, DOT_POLL_MS);
    document.addEventListener("visibilitychange", look);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", look); };
  }, []);
  if (unread === 0) return null;
  return <span className={styles.unreadDot} role="status" aria-label={`${unread} unread ${unread === 1 ? "message" : "messages"} in web chat`} />;
}
