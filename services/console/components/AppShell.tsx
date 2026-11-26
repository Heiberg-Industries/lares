"use client";
import { usePathname } from "next/navigation";
import { SidebarInset } from "@lares/ui/primitives/sidebar";
import { Nav } from "./Nav";
import styles from "./AppShell.module.css";
export function AppShell({ children, owner, person }: { children: React.ReactNode; owner: boolean; person?: string | null }) {
  // The sign-in page is its own full-screen layout, without the console's navigation.
  if (["/sign-in", "/invite"].includes(usePathname())) return <>{children}</>;
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main-content">Skip to content</a>
      <Nav owner={owner} person={person} />
      <SidebarInset id="main-content" className={styles.main}>{children}</SidebarInset>
    </div>
  );
}
