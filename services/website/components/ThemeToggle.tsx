"use client";

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
        localStorage.setItem("lares-website-appearance", next ? "dark" : "light");
        setDark(next);
      }}
    >
      {dark ? "Light" : "Dark"}
    </button>
  );
}
