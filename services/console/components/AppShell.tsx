"use client";
import { usePathname } from "next/navigation";
import { SidebarInset } from "@lares/ui/primitives/sidebar";
import { Nav, type MenuLevel } from "./Nav";
import styles from "./AppShell.module.css";
export function AppShell({ children, level, person }: { children: React.ReactNode; level: MenuLevel; person?: string | null }) {
  // The sign-in page is its own full-screen layout, without the console's navigation.
  if (["/sign-in", "/invite"].includes(usePathname())) return <>{children}</>;
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main-content">Skip to content</a>
      <Nav level={level} person={person} />
      <SidebarInset id="main-content" className={styles.main}>{children}</SidebarInset>
    </div>
  );
}
