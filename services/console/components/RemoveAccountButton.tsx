"use client";
import { useState, useTransition } from "react";
import { removeAccount } from "../app/actions/accounts";

export function RemoveAccountButton(p: { email: string }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button
        disabled={pending}
        title={`Disconnect ${p.email}`}
        onClick={() =>
          start(async () => {
            setErr("");
            try {
              await removeAccount({ email: p.email });
            } catch (e) {
              setErr(String(e instanceof Error ? e.message : e));
            }
          })
        }
        style={{
          border: "1px solid var(--rule)", borderRadius: 4, padding: "2px 8px",
          cursor: pending ? "default" : "pointer", background: "var(--card)",
          color: "var(--bad)", fontSize: 12,
        }}
      >
        {pending ? "…" : "Remove"}
      </button>
      {err && <span title={err} style={{ color: "var(--bad)" }}>!</span>}
    </span>
  );
}
