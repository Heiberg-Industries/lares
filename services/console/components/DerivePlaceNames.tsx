"use client";
import { useState, useTransition } from "react";

import { deriveMissingPlaceNames, type PlaceNameBackfill } from "../app/actions/taste";

const button = {
  padding: "6px 12px",
  fontSize: 13,
  border: "1px solid var(--rule)",
  borderRadius: 3,
  background: "transparent",
  color: "var(--ink)",
  cursor: "pointer",
} as const;

/** One button: derive city and country for every pinned entry that has neither. Offline and
 *  idempotent, so unlike the pin repair it needs no dry run to be safe to press. */
export function DerivePlaceNames() {
  const [result, setResult] = useState<PlaceNameBackfill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        style={button}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            try {
              setResult(await deriveMissingPlaceNames());
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          })
        }
      >
        {pending ? "Fyller inn …" : "Fyll inn by og land"}
      </button>
      {error && <p className="mono" style={{ color: "var(--bad)", fontSize: 12, marginTop: 8 }}>{error}</p>}
      {result && (
        <p className="mono" style={{ fontSize: 12, marginTop: 8, color: "var(--ok)" }}>
          {result.named} fikk by og land
          {result.alreadyNamed > 0 && `, ${result.alreadyNamed} hadde det alt`}
          {result.noPin > 0 && `, ${result.noPin} mangler koordinater`}.
        </p>
      )}
    </div>
  );
}
