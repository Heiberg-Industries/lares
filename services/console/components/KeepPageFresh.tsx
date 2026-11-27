"use client";
import { useRouter } from "next/navigation";
import { useKeepFresh } from "../lib/use-keep-fresh";

/** Re-reads the page's server data every few seconds while `active` (a background run is going), and
 *  stops once it is not: the server page decides `active` from what it last read (ADR 0031). */
export function KeepPageFresh({ active }: { active: boolean }) {
  const router = useRouter();
  useKeepFresh(active, () => router.refresh());
  return null;
}
