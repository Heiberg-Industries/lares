"use client";
import { useTransition } from "react";

import { removeEntry } from "../app/actions/taste";
import { FreshBadge } from "./FreshBadge";
import type { Badge } from "../lib/taste-browse";

/** One row of the browse view. Delete removes the FILE — there is no soft-delete and no undo,
 *  which matches what the store is: a folder of markdown Bendik curates by hand. */
export function TasteEntryRow({
  domain,
  file,
  name,
  detail,
  badge,
  broken,
}: {
  domain: string;
  file: string;
  name: string;
  detail: string;
  badge?: Badge;
  broken?: string;
}) {
  const [pending, start] = useTransition();
  return (
    <tr style={pending ? { opacity: 0.4 } : undefined}>
      <td className="mono">
        {name}
        {badge && <> <FreshBadge badge={badge} /></>}
        {broken && (
          <span style={{ color: "var(--bad)", fontSize: 12 }}> · uleselig fil: {broken}</span>
        )}
      </td>
      <td style={{ color: "var(--mist)", fontSize: 12 }}>{detail}</td>
      <td style={{ color: "var(--mist)", fontSize: 12 }}>{file}</td>
      <td>
        <button
          disabled={pending}
          onClick={() => start(async () => { await removeEntry({ domain, file }); })}
          style={{
            padding: "2px 8px", fontSize: 12, border: "1px solid var(--rule)", borderRadius: 3,
            background: "transparent", color: "var(--mist)", cursor: "pointer",
          }}
        >
          Slett
        </button>
      </td>
    </tr>
  );
}
