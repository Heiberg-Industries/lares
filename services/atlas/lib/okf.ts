// services/atlas/lib/okf.ts
// Atlas's own path→type mapping. The OKF vocabulary and the conformance check now live in
// @lares/vault-format/okf (ADR-0017 rule 3: the check runs over every area of the Vault, not
// only Atlas) — this file keeps only what is specific to the Atlas bundle's own layout.
//
// OKF v0.2 requires exactly one frontmatter key — `type` — on every non-reserved .md file,
// and reserves `index.md` and `log.md`. The Atlas has neither and must not grow one.

/** ext4 box vs APFS Mac: compare on a normalised, lowercased form, never raw. */
function normPath(p: string): string {
  return p.normalize("NFC").toLowerCase().replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Where a file lives IS its type in this store — the layout is the taxonomy. Throwing on an
 * unrecognised location is deliberate: a silent default would let a file into the bundle
 * wearing a type nobody chose, and OKF's whole promise is that `type` means something.
 */
export function okfTypeFor(atlasRelPath: string): "venture" | "index" | "reference" | "profile" | "note" {
  const p = normPath(atlasRelPath);
  if (p.startsWith("_projects/")) return "venture";
  if (p.startsWith("icp/")) return "profile";
  if (p.startsWith("_inbox/")) return "note";
  if (p === "_portfolio.md" || p === "readme.md") return "index";
  if (p === "_entities.md" || p === "schema.md") return "reference";
  throw new Error(
    `atlas: no OKF type is defined for "${atlasRelPath}". Add it to okfTypeFor (and to the ` +
    "vocabulary table in the Part B plan) rather than letting it into the bundle untyped.",
  );
}
