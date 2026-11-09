"use client";
import Link from "next/link";
import { useState } from "react";
import { Search } from "@lares/ui/icons";
import { Input } from "@lares/ui/primitives/input";
import type { IntegrationCard } from "../lib/integrations-grid";
import { LogoTile } from "./LogoTile";

const STATUS_TEXT = { enabled: "Enabled", available: "Connect", unavailable: "Status unavailable" } as const;

function Cards({ cards }: { cards: IntegrationCard[] }) {
  return (
    <div className="lares-card-grid">
      {cards.map(c => (
        <Link key={c.id} href={c.href} className="lares-card-link">
          <div className="lares-card-top">
            <LogoTile logo={c.logo} label={`${c.name} logo`} />
            <span className="lares-card-status" data-enabled={c.status === "enabled"}>{STATUS_TEXT[c.status]}</span>
          </div>
          <div className="lares-service-name">{c.name}</div>
          <p className="lares-service-line">{c.line}</p>
        </Link>
      ))}
    </div>
  );
}

/** Enabled cards first, then the rest. Without JavaScript the search does nothing and every card shows. */
export function IntegrationsGrid({ cards }: { cards: IntegrationCard[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? cards.filter(c => c.name.toLowerCase().includes(q)) : cards;
  const enabled = shown.filter(c => c.status === "enabled");
  const rest = shown.filter(c => c.status !== "enabled");
  return (
    <>
      <div className="lares-stack">
        <label htmlFor="integrations-search" className="sr-only">Search integrations</label>
        <div className="lares-actions"><Search aria-hidden="true" width={16} height={16} />
          <Input id="integrations-search" type="search" placeholder="Notion, Slack, CRM…" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
      </div>
      {enabled.length > 0 && <section aria-labelledby="sec-enabled" className="lares-stack"><h2 id="sec-enabled" className="lares-section-title">Enabled</h2><Cards cards={enabled} /></section>}
      {rest.length > 0 && <section aria-labelledby="sec-available" className="lares-stack"><h2 id="sec-available" className="lares-section-title">Available</h2><Cards cards={rest} /></section>}
      {shown.length === 0 && <p className="lares-muted" role="status">No integration matches “{query.trim()}”.</p>}
    </>
  );
}
