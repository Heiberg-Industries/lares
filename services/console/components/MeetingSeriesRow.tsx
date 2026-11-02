"use client";
import { Button } from "@lares/ui/primitives/button";
import { useState, useTransition } from "react";
import { revokeSeries } from "../app/actions/meeting-series";

export function MeetingSeriesRow(p: {
  agent: string;
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
      <td className="mono lares-status-muted">{p.updatedBy}</td>
      <td className="mono lares-status-muted">{p.updatedAt}</td>
      <td>
        <span className="lares-actions">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            title={`Turn off auto-send for ${p.name}`}
            onClick={() =>
              start(async () => {
                setErr("");
                try {
                  await revokeSeries(p.agent, p.seriesKey);
                  setRevoked(true);
                } catch (e) {
                  setErr(String(e instanceof Error ? e.message : e));
                }
              })
            }
          >
            {pending ? "…" : "Revoke"}
          </Button>
          {err && <span title={err} className="lares-status-error">!</span>}
        </span>
      </td>
    </tr>
  );
}
