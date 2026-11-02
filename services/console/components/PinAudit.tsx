"use client";
import { Button } from "@lares/ui/primitives/button";
import { useState, useTransition } from "react";

import { repairContradictedPins, type PinRepairResult } from "../app/actions/taste";

const km = (metres: number) => (metres >= 1000 ? `${Math.round(metres / 1000)} km` : `${metres} m`);

/**
 * The pin audit, as an operator surface.
 *
 * Two buttons rather than one, deliberately: this rewrites entries the owner did not just upload, so
 * it must be able to show its work before it does anything. "Se etter" is read-only; "Rett dem"
 * only appears once there is a list to look at.
 */
export function PinAudit() {
  const [result, setResult] = useState<PinRepairResult | null>(null);
  const [repaired, setRepaired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (dryRun: boolean) =>
    start(async () => {
      setError(null);
      try {
        setResult(await repairContradictedPins({ dryRun }));
        setRepaired(!dryRun);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  return (
    <div className="lares-row-actions">
      <div className="lares-actions">
        <Button type="button" variant="outline" disabled={pending} onClick={() => run(true)}>
          {pending ? "Checking…" : "Find misplaced pins"}
        </Button>
        {result !== null && result.found > 0 && !repaired && (
          <Button type="button" disabled={pending} onClick={() => run(false)}>
            Correct {result.found} pins
          </Button>
        )}
      </div>

      {error && (
        <p className="mono lares-small lares-status-warning lares-row-actions">{error}</p>
      )}

      {result !== null && (
        <div className="lares-row-actions">
          <p className="mono lares-small">
            {result.found === 0
              ? "No saved pins conflict with their source links."
              : repaired
                ? `Corrected ${result.exact} of ${result.found} with confirmed matches. ${result.kept} stayed unchanged because no better location was confirmed (${result.searches} lookups).`
                : `${result.found} pins are far from their source links. Nothing has changed yet.`}
          </p>
          {result.rows.length > 0 && (
            <div className="lares-table-scroll"><table className="mono lares-small">
              <tbody>
                {result.rows.map((row) => (
                  <tr key={`${row.sourceList}/${row.name}`}>
                    <td className="lares-status-muted">{row.sourceList}</td>
                    <td>{row.name}</td>
                    <td className="lares-status-muted">{km(row.wrongBy)} away</td>
                    <td>
                      {row.outcome === "exact" ? "→ confirmed" : `→ unchanged${row.reason ? ` (${row.reason})` : ""}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      )}
    </div>
  );
}
