"use client";
import { Notice, Row } from "@lares/ui/patterns";
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
    <Row
      title={p.name}
      description={<>Turned on by {p.updatedBy} on {p.updatedAt}</>}
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          aria-label={`Revoke: stop sending follow-ups for ${p.name} without asking`}
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
          {pending ? "Revoking…" : "Revoke"}
        </Button>
      }
    >
      {err && <Notice error>Not revoked: {err}</Notice>}
    </Row>
  );
}
