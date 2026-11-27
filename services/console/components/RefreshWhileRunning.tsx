"use client";
import { useRouter } from "next/navigation";
import { useKeepFresh } from "../lib/use-keep-fresh";

/** Re-reads the page's server data every few seconds while `active`, and stops when it is not
 *  (ADR 0031). For a server-rendered status that has no button of its own, such as a schedule's last run. */
export function RefreshWhileRunning({ active }: { active: boolean }) {
  const router = useRouter();
  useKeepFresh(active, () => router.refresh());
  return null;
}
