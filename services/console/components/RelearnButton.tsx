"use client";
import { Notice, RunStatus } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { requestRelearn } from "../app/actions/voice";
import type { RelearnStatusView } from "../lib/voice";
import { useKeepFresh } from "../lib/use-keep-fresh";

/**
 * The Re-learn button and where learning is. `status` is the whole job's state (the request, the
 * schedule's last outcome, and each mailbox's own row: `lib/voice.ts`'s `relearnStatus`), never the
 * shared `default` card's columns, which no run writes. While something is asked for or running the
 * page re-reads itself every few seconds, and stops once it is not.
 */
export function RelearnButton({ status }: { status: RelearnStatusView | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  useKeepFresh(status?.active === true, () => router.refresh());
  const running = status?.state === "running";
  return (
    <div className="lares-stack">
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={pending || running}
          onClick={() => start(async () => {
            setFailed(false);
            try { await requestRelearn(); } catch { setFailed(true); }
          })}
        >
          {running ? "Learning…" : "Re-learn from Sent mail"}
        </Button>
      </div>
      {status && <RunStatus label="Learning from Sent mail" state={status.state} when={status.when} why={status.why} fix={status.fix} />}
      {failed && <Notice error>Could not ask for it just now. Reload the page and try again.</Notice>}
    </div>
  );
}
