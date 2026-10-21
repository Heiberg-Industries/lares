"use client";
import { useState, useTransition } from "react";
import { removeAccount } from "../app/actions/accounts";

export function RemoveAccountButton(p: { email: string; accountId?: string; generation?: number }) {
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
              await removeAccount(p.accountId !== undefined && p.generation !== undefined
                ? { accountId: p.accountId, generation: p.generation } : { email: p.email });
            } catch (e) {
              setErr("Account could not be disconnected. Refresh and try again.");
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
