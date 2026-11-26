"use client";
import { useState, useTransition } from "react";
import { Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { removeAccount } from "../app/actions/accounts";

export function RemoveAccountButton(p: { email: string; accountId?: string; generation?: number }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  return (
    <div className="lares-actions">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        title={`Disconnect ${p.email}`}
        onClick={() =>
          start(async () => {
            setErr("");
            try {
              await removeAccount(p.accountId !== undefined && p.generation !== undefined
                ? { accountId: p.accountId, generation: p.generation } : { email: p.email });
            } catch (e) {
              setErr("Account could not be disconnected. Refresh and try again.");
            }
          })
        }
      >
        {pending ? "…" : "Remove"}
      </Button>
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}
