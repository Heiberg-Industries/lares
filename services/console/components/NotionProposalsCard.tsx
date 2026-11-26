"use client";
import { Notice, Row, Rows } from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { useState, useTransition } from "react";
import type { NotionProposalDTO, FrozenDocDTO } from "../lib/notion-proposals";
import { approveConsequence, rejectConsequence } from "@lares/agent-box/lib/notion-proposals.js";
import { NOTION_RESOLVE_GUIDANCE } from "../lib/contracts";

async function postAction(id: number, action: "approve" | "reject"): Promise<void> {
  const res = await fetch("/api/notion-proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, action }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.message === "string" ? body.message : `request failed (${res.status})`);
  }
}

function ProposalRow(p: { proposal: NotionProposalDTO; onResolved: (id: number) => void }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");

  function act(action: "approve" | "reject") {
    setErr("");
    start(async () => {
      try {
        await postAction(p.proposal.id, action);
        p.onResolved(p.proposal.id);
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
      }
    });
  }

  // THREE different decisions, not two, and Reject is where they diverge most
  // An ordinary edit's rejection UNDOES the owner's Notion edit; a Notion-owned
  // document's writes nothing on either side; a create's simply declines. Stated per
  // row rather than once at the top, because a mixed queue makes any single blanket
  // sentence wrong for part of it — and phrased by the SHARED consequence functions,
  // never by this component, so the card cannot drift from what the engine does.
  const isCreate = p.proposal.kind === "create";

  return (
    <Row
      title={<><span className="mono">{p.proposal.vaultPath}</span>{isCreate && <> <Badge variant="info">New file</Badge></>}</>}
      description={<>{p.proposal.state} · {p.proposal.createdAt.slice(0, 10)}</>}
    >
      <pre className="lares-pre lares-small">{p.proposal.preview}</pre>
      <p className="lares-muted">
        {isCreate && "This file does not exist in the vault yet. "}
        Approve: {approveConsequence(p.proposal)}. Reject: {rejectConsequence(p.proposal)}.
      </p>
      <div className="lares-actions">
        <Button type="button" disabled={pending} onClick={() => act("approve")}>
          Approve
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => act("reject")}>
          Reject
        </Button>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
    </Row>
  );
}

export function NotionProposalsCard(p: { proposals: NotionProposalDTO[]; frozen: FrozenDocDTO[] }) {
  // Optimistic list ownership (same posture as AutonomyControl's local level
  // state): a resolved proposal is no longer "open" from this card's point of
  // view the moment approve/reject succeeds, even though the engine's actual
  // write (apply or revert) happens on its next tick, not right now.
  const [proposals, setProposals] = useState(p.proposals);
  const resolve = (id: number) => setProposals((cur) => cur.filter((row) => row.id !== id));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Notion proposals {proposals.length > 0 && `(${proposals.length})`}
          </CardTitle>
          <CardDescription>
            Changes made in Notion that wait for your yes or no: edits to files that exist, and
            files Notion wants to add (marked New file). What each choice means is stated on each
            one: rejecting does one of three different things depending on which side owns the
            document. Either way the change is written the next time the sync runs, not immediately.
          </CardDescription>
        </CardHeader>
        {proposals.length === 0 ? (
          <CardContent><p className="lares-muted">No open proposals.</p></CardContent>
        ) : (
          <Rows label="Notion proposals">
            {proposals.map((proposal) => (
              <ProposalRow key={proposal.id} proposal={proposal} onResolved={resolve} />
            ))}
          </Rows>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Frozen {p.frozen.length > 0 && `(${p.frozen.length})`}
          </CardTitle>
          {p.frozen.length > 0 && (
            <CardDescription>
              Conflicts that cannot be settled from this page. Someone has to pick a side on the
              server, with the sync stopped. <code>--keep md</code> overwrites the Notion page from the vault;{" "}
              <code>--keep notion</code> queues a proposal you still approve. {NOTION_RESOLVE_GUIDANCE}
            </CardDescription>
          )}
        </CardHeader>
        {p.frozen.length === 0 ? (
          <CardContent><p className="lares-muted">Nothing frozen.</p></CardContent>
        ) : (
          <Rows label="Frozen documents">
            {p.frozen.map((row) => (
              <Row key={row.vaultPath} title={<span className="mono">{row.vaultPath}</span>}
                description={<>{row.reason ?? "No reason recorded"} · frozen {row.frozenAt.slice(0, 10)}</>} />
            ))}
          </Rows>
        )}
      </Card>
    </>
  );
}
