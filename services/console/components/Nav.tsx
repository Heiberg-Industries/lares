"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./AppShell.module.css";

const items = [
  { href: "/", label: "Agents", active: (path: string) => path === "/" || path.startsWith("/agents") },
  { href: "/chat", label: "Chat", active: (path: string) => path.startsWith("/chat") },
  { href: "/activity", label: "Activity", active: (path: string) => path === "/activity" },
  { href: "/integrations", label: "Connections", active: (path: string) => path === "/integrations" },
  { href: "/signals", label: "Signals", active: (path: string) => path.startsWith("/signals") },
  { href: "/voice", label: "Voice", active: (path: string) => path === "/voice" },
  { href: "/proactivity", label: "Proactivity", active: (path: string) => path === "/proactivity" },
  { href: "/deadlines", label: "Deadlines", active: (path: string) => path === "/deadlines" },
  { href: "/backup", label: "Backup", active: (path: string) => path === "/backup" },
  { href: "/meetings", label: "Meetings", active: (path: string) => path === "/meetings" },
  { href: "/taste", label: "Saved preferences", active: (path: string) => path === "/taste" },
  { href: "/markets", label: "Market watch", active: (path: string) => path === "/markets" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className={styles.nav} aria-label="Console navigation">
      <Link className={styles.brand} href="/">lares</Link>
      <div className={styles.navItems}>
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`${styles.navItem} ${item.active(pathname) ? styles.current : ""}`}
            aria-current={item.active(pathname) ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
