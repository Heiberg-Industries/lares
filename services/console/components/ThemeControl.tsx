"use client";
import { useEffect, useState } from "react";
import { Sun, Moon, Monitor } from "@lares/ui/icons";
import { Button } from "@lares/ui/primitives/button";
export type Theme = "light" | "dark" | "system";
const key = "lares-console-theme";

export function useConsoleTheme() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      setTheme(stored === "light" || stored === "dark" ? stored : "system");
    } catch {
      setTheme("system");
    }
  }, []);
  useEffect(() => {
    if (theme === null) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  function choose(next: Theme) {
    setTheme(next);
    try {
      localStorage.setItem(key, next);
    } catch {}
  }
  return { theme: theme ?? "system", onChange: choose };
}
export function ThemeControl({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (next: Theme) => void;
}) {
  return (
    <div className="lares-actions" role="group" aria-label="Color theme">
      {(
        [
          { value: "light", Icon: Sun },
          { value: "dark", Icon: Moon },
          { value: "system", Icon: Monitor },
        ] as const
      ).map(({ value, Icon }) => (
        <Button
          key={value}
          variant={theme === value ? "secondary" : "ghost"}
          size="icon"
          aria-label={`${value} theme`}
          aria-pressed={(theme ?? "system") === value}
          onClick={() => onChange(value)}
        >
          <Icon aria-hidden="true" />
        </Button>
      ))}
    </div>
  );
}
