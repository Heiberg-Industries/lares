import type { ReactNode } from "react";
import { Mark } from "@lares/ui/patterns";
import styles from "../app/sign-in/sign-in.module.css";

/** The signed-out pages' full-screen layout: the graphic panel, then the page's own card. */
export function DoorLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      <section className={styles.panel} aria-label="About Lares">
        <div className={`${styles.light} ${styles.lightOne}`} aria-hidden="true" />
        <div className={`${styles.light} ${styles.lightTwo}`} aria-hidden="true" />
        <svg className={styles.grain} aria-hidden="true">
          <filter id="sign-in-grain">
            <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#sign-in-grain)" />
        </svg>
        <div className={styles.brand}><Mark />Lares</div>
        <div className={styles.message}>
          <h2 className={styles.headline}>Your agents. Your server.</h2>
          <p className={styles.lead}>Lares runs the day-to-day of your business on a machine you control. Nothing leaves it unless you say so.</p>
        </div>
      </section>
      <main className={styles.side} id="main-content">
        <div className={styles.card}>
          {children}
        </div>
      </main>
    </div>
  );
}
