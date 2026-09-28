"use client";
import { useTransition } from "react";
import { Button } from "@lares/ui/primitives/button";

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
          <span style={{ color: "var(--bad)", fontSize: 12 }}> · unreadable file: {broken}</span>
        )}
      </td>
      <td style={{ color: "var(--mist)", fontSize: 12 }}>{detail}</td>
      <td style={{ color: "var(--mist)", fontSize: 12 }}>{file}</td>
      <td>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (window.confirm(`Permanently remove ${name} from preferences?`)) {
              start(async () => { await removeEntry({ domain, file }); });
            }
          }}
        >
          Delete
        </Button>
      </td>
    </tr>
  );
}
