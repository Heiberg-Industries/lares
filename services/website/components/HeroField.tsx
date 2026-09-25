"use client";

import { useId, useState, type ReactNode } from "react";

export function HeroField({ children }: { children: ReactNode }) {
  const [paused, setPaused] = useState(false);
  const filterId = useId();
  return (
    <div className={`hero-field${paused ? " motion-paused" : ""}`}>
      <div className="gradient-light light-one" aria-hidden="true" />
      <div className="gradient-light light-two" aria-hidden="true" />
      <svg className="hero-grain" aria-hidden="true" focusable="false">
        <filter id={filterId}>
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${filterId})`} />
      </svg>
      <div className="hero-content">{children}</div>
      <button
        className="hero-motion-control"
        type="button"
        onClick={() => setPaused((value) => !value)}
        aria-label={paused ? "Play background animation" : "Pause background animation"}
        aria-pressed={paused}
      >
        <span aria-hidden="true">{paused ? "▶" : "Ⅱ"}</span> {paused ? "Play motion" : "Pause motion"}
      </button>
    </div>
  );
}
