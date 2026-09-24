"use client";
import { useState, useTransition } from "react";

import { repairContradictedPins, type PinRepairResult } from "../app/actions/taste";

const button = {
  padding: "6px 12px",
  fontSize: 13,
  border: "1px solid var(--rule)",
  borderRadius: 3,
  background: "transparent",
  color: "var(--ink)",
  cursor: "pointer",
} as const;

const km = (metres: number) => (metres >= 1000 ? `${Math.round(metres / 1000)} km` : `${metres} m`);

/**
 * The pin audit, as an operator surface.
 *
 * Two buttons rather than one, deliberately: this rewrites entries Bendik did not just upload, so
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
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={button} disabled={pending} onClick={() => run(true)}>
          {pending ? "Ser etter …" : "Se etter feil pins"}
        </button>
        {result !== null && result.found > 0 && !repaired && (
          <button type="button" style={button} disabled={pending} onClick={() => run(false)}>
            Rett {result.found} pins
          </button>
        )}
      </div>

      {error && (
        <p className="mono" style={{ color: "var(--warn, #c66)", fontSize: 12, marginTop: 8 }}>{error}</p>
      )}

      {result !== null && (
        <div style={{ marginTop: 8 }}>
          <p className="mono" style={{ fontSize: 12 }}>
            {result.found === 0
              ? "Ingen pins motsies av sin egen lenke."
              : repaired
                ? `Rettet ${result.exact} av ${result.found} med bekreftet treff. ${result.kept} står urørt — ingenting bekreftet en bedre posisjon, og da er den lagrede pinnen like gjerne den riktige (${result.searches} oppslag).`
                : `${result.found} pins ligger et helt annet sted enn lenken sier. Ingenting er skrevet ennå.`}
          </p>
          {result.rows.length > 0 && (
            <table className="mono" style={{ fontSize: 12, marginTop: 8, borderCollapse: "collapse" }}>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={`${row.sourceList}/${row.name}`}>
                    <td style={{ padding: "2px 12px 2px 0", color: "var(--mist)" }}>{row.sourceList}</td>
                    <td style={{ padding: "2px 12px 2px 0" }}>{row.name}</td>
                    <td style={{ padding: "2px 12px 2px 0", color: "var(--mist)" }}>{km(row.wrongBy)} feil</td>
                    <td style={{ padding: "2px 0" }}>
                      {row.outcome === "exact" ? "→ bekreftet" : `→ urørt${row.reason ? ` (${row.reason})` : ""}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
