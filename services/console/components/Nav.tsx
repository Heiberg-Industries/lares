"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  MessageSquareText,
  UsersRound,
  History,
  Plug,
  CalendarDays,
  Bookmark,
  ChartNoAxesCombined,
  Settings2,
  Menu,
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
import styles from "./AppShell.module.css";
const main = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/chat", label: "Chat", Icon: MessageSquareText },
  { href: "/agents", label: "Agents", Icon: UsersRound },
  { href: "/activity", label: "Activity", Icon: History },
  { href: "/integrations", label: "Connections", Icon: Plug },
];
const tools = [
  { href: "/deadlines", label: "Deadlines", Icon: CalendarDays },
  { href: "/taste", label: "Saved preferences", Icon: Bookmark },
  { href: "/markets", label: "Market watch", Icon: ChartNoAxesCombined },
];
export function Nav() {
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
    </Link>
  );
  const contents = (
    <>
      <Link className={styles.brand} href="/" onClick={() => setOpen(false)}>
        <Mark />
        lares
      </Link>
      <nav aria-label="Console navigation" className={styles.navItems}>
        {main.map(item)}
        <p className={styles.groupLabel}>Tools</p>
        {tools.map(item)}
      </nav>
      <div className={styles.bottom}>
        {item({ href: "/settings", label: "Settings", Icon: Settings2 })}
        <ThemeControl {...theme} />
        <p className={styles.installation}>this installation</p>
      </div>
    </>
  );
  return (
    <>
      <aside className={styles.sidebar}>{contents}</aside>
      <div className={styles.mobileBar}>
        <Link className={styles.brand} href="/">
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
