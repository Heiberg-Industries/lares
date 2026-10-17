"use client";
import { usePathname } from "next/navigation";
import { Nav } from "./Nav";
import styles from "./AppShell.module.css";
export function AppShell({ children }: { children: React.ReactNode }) {
  // The sign-in page is its own full-screen layout, without the console's navigation.
  if (usePathname() === "/sign-in") return <>{children}</>;
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main-content">Skip to content</a>
      <Nav />
      <main id="main-content" className={styles.main}>{children}</main>
    </div>
  );
}
