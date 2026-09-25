"use client";

import { capture } from "../lib/analytics";
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
        onClick={() => { capture("hero_motion_changed", { paused: !paused }); setPaused(!paused); }}
        aria-label={paused ? "Play background animation" : "Pause background animation"}
        aria-pressed={paused}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">{paused ? <path d="m5 3 7 5-7 5Z"/> : <><rect x="4" y="3" width="2" height="10" rx=".5"/><rect x="10" y="3" width="2" height="10" rx=".5"/></>}</svg> {paused ? "Play motion" : "Pause motion"}
      </button>
    </div>
  );
}
