// The Connections rows a console page would read (ADR-0019's "console's Connections rows"
// generated output). Pure data, mapped straight from the integration manifests — no I/O beyond
// what `loadIntegrationManifests` already did, no secrets, no tokens, nothing box-shaped.
//
// `tier` is hard-wired `null`: W6C-s2's checker is what COMPUTES a tier from a `quality.yaml`'s
// actual rule statuses (the tier a manifest's `quality` file points at is a CLAIM, never a fact
// until that checker has run it) — so this module does not read a `quality.yaml` at all yet.

import type { AdapterRegion } from "./persona/capability-docs.js";
import { CAPABILITY_DOCS } from "./persona/capability-docs.js";
import type { DataPath, IntegrationManifest, Provenance } from "./integration-manifest.js";

/** One row of a Connections list, in owner words. Pure data: no I/O, no secrets, no tokens —
 *  a secret's NAME only, never a value and never whether it is currently present (that is a
 *  box question and this function never touches a box). */
export interface IntegrationRow {
  id: string;
  name: string;
  /** "Runs on your server" | "In the EU" | "Outside the EU" | "Wherever you point it" */
  whereTheDataGoes: string;
  /** "Where it works: worldwide" or "Where it works: NOR — <reason>" */
  whereItWorks: string;
  /** What the agent can do with it, from the capability docs — never invented here. */
  capabilities: string[];
  /** Secret FILE names this installation must provide, sorted. */
  needs: string[];
  provenance: Provenance;
  /** null until 6C lands a quality.yaml; then bronze | silver | gold. */
  tier: string | null;
}

export const DATA_PATH_WORDS: Record<DataPath, string> = {
  self_hosted: "Runs on your server",
  eu_cloud: "In the EU",
  non_eu_cloud: "Outside the EU",
  owner_chosen: "Wherever you point it",
};

function renderWhereItWorks(region: AdapterRegion): string {
  if (region === "global") return "Where it works: worldwide";
  return `Where it works: ${region.countries.join(", ")} — ${region.reason}`;
}

export function integrationRows(manifests: readonly IntegrationManifest[]): IntegrationRow[] {
  return manifests.map((m) => ({
    id: m.id,
    name: m.name,
    whereTheDataGoes: DATA_PATH_WORDS[m.data_path],
    whereItWorks: renderWhereItWorks(m.region),
    capabilities: m.capability.filter((c) => c in CAPABILITY_DOCS),
    needs: [...m.secrets].sort(),
    provenance: m.provenance,
    tier: null,
  }));
}
