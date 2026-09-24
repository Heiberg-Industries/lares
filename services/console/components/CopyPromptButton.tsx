"use client";
// Imports NOTHING but react — deliberately. This component exists so the CRM section can stay a
// server component: the prompt is built on the server by a pure function and handed here as a
// plain string. Importing anything from lib/ risks dragging `pg` into the browser bundle, which
// is the ORB-39 trap that held console CI red for a day.
import { useState } from "react";

export function CopyPromptButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mono"
      style={{ fontSize: 11, marginTop: 4, cursor: "pointer" }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(prompt);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard denied (no permission, or a non-secure context). Say so rather than
          // flashing a success the user did not get.
          window.prompt("Copy this prompt:", prompt);
        }
      }}
    >
      {copied ? "✓ copied" : "Copy prompt for Claude Code"}
    </button>
  );
}
