"use client";
import Link from "next/link";
import { useState } from "react";
import { Notice, Row, Rows } from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Button } from "@lares/ui/primitives/button";
import { Card } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
import { STATUS_BADGE, STATUS_TEXT, type IntegrationCard } from "../lib/integrations-grid";

/** One plain row per service: its name, one line of purpose, its status in words and one link to its page. */
function List({ id, title, cards }: { id: string; title: string; cards: IntegrationCard[] }) {
  return (
    <section aria-labelledby={id} className="lares-stack">
      <h2 id={id} className="lares-section-title">{title}</h2>
      <Card>
        <Rows>
          {cards.map(c => (
            <Row key={c.id} title={c.name} description={c.line} control={<>
              <Badge variant={STATUS_BADGE[c.status]}>{STATUS_TEXT[c.status]}</Badge>
              <Button variant="outline" size="sm" asChild><Link href={c.href} aria-label={`Open ${c.name}`}>Open</Link></Button>
            </>} />
          ))}
        </Rows>
      </Card>
    </section>
  );
}

/** Enabled services first, then the rest. Without JavaScript the search does nothing and every row shows. */
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
        <Input id="integrations-search" type="search" placeholder="Search: Notion, Slack, CRM…" value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      {enabled.length > 0 && <List id="sec-enabled" title="Enabled" cards={enabled} />}
      {rest.length > 0 && <List id="sec-available" title="Available" cards={rest} />}
      {shown.length === 0 && <Notice>No integration matches “{query.trim()}”.</Notice>}
    </>
  );
}
