"use client";
import { useState, useTransition } from "react";
import type { NotionProposalDTO, FrozenDocDTO } from "../lib/notion-proposals";
import { approveConsequence, rejectConsequence } from "@lares/agent-box/lib/notion-proposals.js";
import { NOTION_RESOLVE_COMMAND } from "../lib/contracts";

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
  // (Phase 4): an ordinary edit's rejection UNDOES his Notion edit; a Notion-owned
  // document's writes nothing on either side; a create's simply declines. Stated per
  // row rather than once at the top, because a mixed queue makes any single blanket
  // sentence wrong for part of it — and phrased by the SHARED consequence functions,
  // never by this component, so the card cannot drift from what the engine does.
  const isCreate = p.proposal.kind === "create";

  return (
    <div className="card" style={{ padding: 12, marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 12, color: "var(--signal)" }}>
        {isCreate && <span style={{ color: "var(--mist)" }}>NEW FILE </span>}
        {p.proposal.vaultPath} <span style={{ color: "var(--mist)" }}>· {p.proposal.state} · {p.proposal.createdAt.slice(0, 10)}</span>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, marginTop: 8 }}>{p.proposal.preview}</pre>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 8 }}>
        {isCreate && "This file does not exist in the vault yet. "}
        Approve: {approveConsequence(p.proposal)}. Reject: {rejectConsequence(p.proposal)}.
      </p>
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <button
          disabled={pending}
          onClick={() => act("approve")}
          style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px", background: "var(--signal)", color: "#fff", cursor: pending ? "default" : "pointer" }}
        >
          Approve
        </button>
        <button
          disabled={pending}
          onClick={() => act("reject")}
          style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px", background: "var(--card)", color: "var(--bad)", cursor: pending ? "default" : "pointer" }}
        >
          Reject
        </button>
        {err && <span title={err} style={{ color: "var(--bad)" }}>!</span>}
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
      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Notion proposals {proposals.length > 0 && `(${proposals.length})`}
      </h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        Changes made in Notion, awaiting your approve/reject — edits to files that exist, and
        files Notion wants to add (marked NEW FILE). What each choice means is stated on the
        row: rejecting does one of three different things depending on which side owns the
        document. Either way the write happens on the sync&apos;s next tick, not immediately.
      </p>
      {proposals.length === 0 ? (
        <p style={{ color: "var(--mist)", fontSize: 13, marginTop: 8 }}>No open proposals.</p>
      ) : (
        proposals.map((proposal) => (
          <ProposalRow key={proposal.id} proposal={proposal} onResolved={resolve} />
        ))
      )}

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Frozen {p.frozen.length > 0 && `(${p.frozen.length})`}
      </h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        Conflicts nothing here can resolve automatically — a human picks a side, on the box, with
        the daemon quiesced. <code>--keep md</code> overwrites the Notion page from the vault;{" "}
        <code>--keep notion</code> queues a proposal you still approve.
      </p>
      <pre
        className="mono"
        style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, marginTop: 8, color: "var(--mist)" }}
      >
        {NOTION_RESOLVE_COMMAND}
      </pre>
      {p.frozen.length === 0 ? (
        <p style={{ color: "var(--mist)", fontSize: 13, marginTop: 8 }}>Nothing frozen.</p>
      ) : (
        <table className="card" style={{ marginTop: 8 }}>
          <thead><tr><th>Path</th><th>Reason</th><th>Frozen</th></tr></thead>
          <tbody>
            {p.frozen.map((row) => (
              <tr key={row.vaultPath}>
                <td className="mono">{row.vaultPath}</td>
                <td style={{ color: "var(--mist)" }}>{row.reason ?? "—"}</td>
                <td style={{ color: "var(--mist)" }}>{row.frozenAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
