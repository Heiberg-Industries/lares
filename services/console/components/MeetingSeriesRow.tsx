"use client";
import { useState, useTransition } from "react";
import { revokeSeries } from "../app/actions/meeting-series";

export function MeetingSeriesRow(p: {
  seriesKey: string;
  name: string;
  updatedBy: string;
  updatedAt: string; // ISO, formatted server-side into a date string by the page
}) {
  const [pending, start] = useTransition();
  const [revoked, setRevoked] = useState(false);
  const [err, setErr] = useState("");

  // Optimistic removal on success: revokeSeries doesn't revalidate the page (it mirrors
  // app/actions/autonomy.ts exactly), so the row hides itself once the write lands.
  if (revoked) return null;

  return (
    <tr>
      <td>{p.name}</td>
      <td className="mono" style={{ color: "var(--mist)" }}>{p.updatedBy}</td>
      <td className="mono" style={{ color: "var(--mist)" }}>{p.updatedAt}</td>
      <td>
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <button
            disabled={pending}
            title={`Turn off auto-send for ${p.name}`}
            onClick={() =>
              start(async () => {
                setErr("");
                try {
                  await revokeSeries(p.seriesKey);
                  setRevoked(true);
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
            {pending ? "…" : "Revoke"}
          </button>
          {err && <span title={err} style={{ color: "var(--bad)" }}>!</span>}
        </span>
      </td>
    </tr>
  );
}
