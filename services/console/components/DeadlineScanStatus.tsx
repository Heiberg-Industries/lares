"use client";
import { RunStatus } from "@lares/ui/patterns";
import { useRouter } from "next/navigation";
import type { DeadlineScanView } from "../lib/deadline-scan";
import { useKeepFresh } from "../lib/use-keep-fresh";

/** Where the mail scan for due notices stands (`lib/deadline-scan.ts`). While a scan is running the
 *  page re-reads itself every few seconds, and stops once it is not. */
export function DeadlineScanStatus({ scan }: { scan: DeadlineScanView }) {
  const router = useRouter();
  useKeepFresh(scan.active, () => router.refresh());
  return <RunStatus label="Mail scan for due notices" state={scan.state} when={scan.when} why={scan.why} fix={scan.fix} />;
}
