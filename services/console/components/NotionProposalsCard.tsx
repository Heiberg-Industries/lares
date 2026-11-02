"use client";
import { Button } from "@lares/ui/primitives/button";
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
    <div className="card lares-control-card">
      <div className="mono lares-small lares-status-warning">
        {isCreate && <span className="lares-status-muted">NEW FILE </span>}
        {p.proposal.vaultPath} <span className="lares-status-muted">· {p.proposal.state} · {p.proposal.createdAt.slice(0, 10)}</span>
      </div>
      <pre className="lares-pre lares-small lares-row-actions">{p.proposal.preview}</pre>
      <p className="lares-muted lares-operational-note">
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
        {err && <span title={err} className="lares-status-error">!</span>}
      </div>
    </div>
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
      <h2>
        Notion proposals {proposals.length > 0 && `(${proposals.length})`}
      </h2>
      <p className="lares-muted lares-operational-note">
        Changes made in Notion, awaiting your approve/reject — edits to files that exist, and
        files Notion wants to add (marked NEW FILE). What each choice means is stated on the
        row: rejecting does one of three different things depending on which side owns the
        document. Either way the write happens on the sync&apos;s next tick, not immediately.
      </p>
      {proposals.length === 0 ? (
        <p className="lares-muted lares-operational-note">No open proposals.</p>
      ) : (
        proposals.map((proposal) => (
          <ProposalRow key={proposal.id} proposal={proposal} onResolved={resolve} />
        ))
      )}

      <h2>
        Frozen {p.frozen.length > 0 && `(${p.frozen.length})`}
      </h2>
      {p.frozen.length === 0 ? (
        <p className="lares-muted lares-operational-note">Nothing frozen.</p>
      ) : (
        <>
          <p className="lares-muted lares-operational-note">
            Conflicts nothing here can resolve automatically — a human picks a side, on the box, with
            the daemon quiesced. <code>--keep md</code> overwrites the Notion page from the vault;{" "}
            <code>--keep notion</code> queues a proposal you still approve.
          </p>
          <p className="lares-muted lares-operational-note">
            {NOTION_RESOLVE_GUIDANCE}
          </p>
          <div className="lares-table-scroll"><table className="card lares-operational-table">
            <thead><tr><th>Path</th><th>Reason</th><th>Frozen</th></tr></thead>
            <tbody>
              {p.frozen.map((row) => (
                <tr key={row.vaultPath}>
                  <td className="mono">{row.vaultPath}</td>
                  <td className="lares-status-muted">{row.reason ?? "—"}</td>
                  <td className="lares-status-muted">{row.frozenAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}
    </>
  );
}
