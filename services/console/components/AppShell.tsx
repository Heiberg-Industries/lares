import { Nav } from "./Nav";
import styles from "./AppShell.module.css";
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main-content">Skip to content</a>
      <Nav />
      <main id="main-content" className={styles.main}>{children}</main>
    </div>
  );
}
