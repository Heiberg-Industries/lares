"use client";

import { capture } from "../lib/analytics";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={dark ? "Use light appearance" : "Use dark appearance"}
      onClick={() => {
        const next = !document.documentElement.classList.contains("dark");
        document.documentElement.classList.toggle("dark", next);
        try { localStorage.setItem("lares-website-appearance", next ? "dark" : "light"); } catch {}
        capture("appearance_changed", { appearance: next ? "dark" : "light" });
        setDark(next);
      }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{dark ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></> : <path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10Z"/>}</svg>
    </button>
  );
}
