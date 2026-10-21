"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  MessageSquareText,
  Inbox,
  UsersRound,
  History,
  Plug,
  CalendarDays,
  Bookmark,
  Settings2,
  Menu,
  LogOut,
} from "@lares/ui/icons";
import { HomeIcon, Mark } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
} from "@lares/ui/primitives/dialog";
import { ThemeControl, useConsoleTheme } from "./ThemeControl";
import { InboxDot } from "./InboxDot";
import styles from "./AppShell.module.css";
const main = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/waiting", label: "Waiting on you", Icon: Inbox },
  { href: "/chat", label: "Chat", Icon: MessageSquareText },
  { href: "/agents", label: "Agents", Icon: UsersRound },
  { href: "/activity", label: "Activity", Icon: History },
  { href: "/integrations", label: "Connections", Icon: Plug },
  { href: "/members", label: "Members", Icon: UsersRound },
];
const tools = [
  { href: "/deadlines", label: "Deadlines", Icon: CalendarDays },
  { href: "/taste", label: "Preferences", Icon: Bookmark },
];
export function Nav({owner}:{owner:boolean}) {
  const pathname = usePathname();
  const theme = useConsoleTheme();
  const [open, setOpen] = useState(false);
  function active(href: string) {
    if (href === "/activity" && pathname.startsWith("/signals")) return true;
    if (
      href === "/integrations" &&
      (pathname === "/voice" || pathname === "/meetings")
    )
      return true;
    if (
      href === "/settings" &&
      (pathname === "/backup" || pathname === "/proactivity")
    )
      return true;
    return href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`);
  }
  const item = ({ href, label, Icon }: (typeof main)[number]) => (
    <Link
      key={href}
      href={href}
      onClick={() => setOpen(false)}
      className={`${styles.navItem} ${active(href) ? styles.current : ""}`}
      aria-current={active(href) ? "page" : undefined}
    >
      <Icon aria-hidden="true" />
      {label}
      {owner && href === "/chat" && <InboxDot />}
    </Link>
  );
  const contents = (
    <>
      <Link className={styles.brand} href={owner?"/":"/chat"} onClick={() => setOpen(false)}>
        <Mark />
        lares
      </Link>
      <nav aria-label="Console navigation" className={styles.navItems}>
        {owner?main.map(item):[
          {href:'/chat',label:'Chat',Icon:MessageSquareText},
          {href:'/membership',label:'Membership',Icon:UsersRound},
        ].map(item)}
        {owner && <><p className={styles.groupLabel}>Tools</p>{tools.map(item)}</>}
      </nav>
      <div className={styles.bottom}>
        {owner && item({ href: "/settings", label: "Settings", Icon: Settings2 })}
        <form action="/api/auth/logout" method="post">
          <button type="submit" className={`${styles.navItem} ${styles.signOut}`}>
            <LogOut aria-hidden="true" />
            Sign out
          </button>
        </form>
        <ThemeControl {...theme} />
        <p className={styles.installation}>this installation</p>
      </div>
    </>
  );
  return (
    <>
      <aside className={styles.sidebar}>{contents}</aside>
      <div className={styles.mobileBar}>
        <Link className={styles.brand} href={owner?"/":"/chat"}>
          <Mark />
          lares
        </Link>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu />
            </Button>
          </DialogTrigger>
          <DialogContent
            className={styles.mobileMenu}
            aria-describedby={undefined}
          >
            <DialogTitle className="sr-only">Console navigation</DialogTitle>
            {contents}
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
