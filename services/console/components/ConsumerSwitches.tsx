"use client";
import { Notice, Row, Rows } from "@lares/ui/patterns";
import { CardContent } from "@lares/ui/primitives/card";
import { Switch } from "@lares/ui/primitives/switch";
import { useState } from "react";
import type { ConsumerRow } from "../lib/signals";

/**
 * The spine's two delivery kill switches.
 *
 * They existed in the database from the first migration, with `selfRegisterConsumers` creating
 * them on every boot "so the future console lists them as toggles" — and had no surface at all, so
 * turning off automatic ticket filing meant editing the database directly. Console first: every knob
 * gets a surface, and every switch says in words what it does, because "linear: off" tells an owner
 * nothing about whether their alerts still arrive.
 */
const WHAT: Record<ConsumerRow["name"], { title: string; description: string }> = {
  slack: {
    title: "Post alerts to Slack",
    description: "When off, nothing is posted to any Slack channel. Alerts are still recorded and shown on the Alerts page, and tickets are still filed in Linear. To quieten one channel, change a rule under Advanced instead.",
  },
  linear: {
    title: "File tickets in Linear",
    description: "When off, no new tickets are filed. Alerts are still recorded and still posted to Slack. Tickets that are already open are left as they are.",
  },
};

type Message = { tone: "working" | "success" | "error"; text: string };

export function ConsumerSwitches({ initial, onSave }: {
  initial: ConsumerRow[];
  onSave(consumers: ConsumerRow[]): Promise<void>;
}) {
  const [rows, setRows] = useState(initial);
  const [msg, setMsg] = useState<Message | null>(null);
  async function toggle(name: ConsumerRow["name"], enabled: boolean) {
    const next = rows.map((r) => (r.name === name ? { ...r, enabled } : r));
    setRows(next);
    setMsg({ tone: "working", text: "Saving…" });
    try { await onSave(next); setMsg({ tone: "success", text: `Saved. "${WHAT[name].title}" is now ${enabled ? "on" : "off"}.` }); }
    catch (e) {
      // Put the switch back: a switch that stays flipped after a failed save is a lie about
      // production, and this is the one page where that costs someone their alerts.
      setRows(rows);
      setMsg({ tone: "error", text: `Not saved: ${String(e instanceof Error ? e.message : e)}. The switch is back where it was. Reload this page and try again.` });
    }
  }
  return (
    <>
      <Rows label="Where alerts are delivered">
        {rows.map((r) => (
          <Row
            key={r.name}
            title={WHAT[r.name].title}
            description={WHAT[r.name].description}
            control={<Switch aria-label={WHAT[r.name].title} checked={r.enabled} onCheckedChange={(on) => void toggle(r.name, on)} />}
          />
        ))}
      </Rows>
      {msg && (
        <CardContent className="lares-stack">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </CardContent>
      )}
    </>
  );
}
