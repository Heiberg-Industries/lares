"use client";
import { Button } from "@lares/ui/primitives/button";
import { Notice } from "@lares/ui/patterns";
import { useState, useTransition } from "react";

import { deriveMissingPlaceNames, type PlaceNameBackfill } from "../app/actions/taste";

/** One button: derive city and country for every pinned entry that has neither. Offline and
 *  idempotent, so unlike the pin repair it needs no dry run to be safe to press. */
export function DerivePlaceNames() {
  const [result, setResult] = useState<PlaceNameBackfill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="lares-stack">
      <Button
        type="button"
        variant="outline"
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
        {pending ? "Filling in…" : "Fill in city and country"}
      </Button>
      {error && <Notice error>{error}</Notice>}
      {result && (
        <Notice tone="success">
          {result.named} received a city and country
          {result.alreadyNamed > 0 && `, ${result.alreadyNamed} already had them`}
          {result.noPin > 0 && `, ${result.noPin} have no coordinates`}.
        </Notice>
      )}
    </div>
  );
}
