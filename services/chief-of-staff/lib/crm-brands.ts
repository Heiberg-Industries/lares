/**
 * Owner annotations for tracks already reported by Twenty's live metadata — installation data,
 * never engine code. Entries cannot add tracks or steps.
 *
 * `CRM_BRANDS` is a JSON array of `{ "id": "EXACT_TRACK_VALUE", "description": "one line",
 * "closingSteps": ["EXACT_STAGE_VALUE"] }`. The exact `id` matches an option value from the live
 * Opportunity.brand field. Twenty's metadata provides available values, labels and order, while
 * business purpose and terminal meaning are owner-specific annotations it does not express.
 * `description` therefore explains an existing track to the router; exact `closingSteps` values
 * mark its closing steps. Twenty remains the truth for workflow records, values and step order.
 * Stale or missing annotations make the Twenty Tracks adapter fail closed.
 */
export interface CrmBrand {
  id: string;
  description: string;
  closingSteps?: string[];
}

export function crmBrands(env: Record<string, string | undefined> = process.env): CrmBrand[] {
  const raw = env["CRM_BRANDS"];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const brands: CrmBrand[] = [];
    for (const item of parsed) {
      const rec = item as { id?: unknown; description?: unknown; closingSteps?: unknown };
      if (typeof rec?.id !== "string" || rec.id.trim() === "") throw new Error("an entry has no id");
      if (brands.some((brand) => brand.id === rec.id)) throw new Error(`duplicate track annotation for ${rec.id}`);
      if (rec.closingSteps !== undefined && (!Array.isArray(rec.closingSteps) || rec.closingSteps.some((step) => typeof step !== "string"))) {
        throw new Error(`closingSteps for ${rec.id} must be an array of exact stage values`);
      }
      brands.push({
        id: rec.id,
        description: typeof rec.description === "string" ? rec.description.trim() : "",
        ...(rec.closingSteps === undefined ? {} : { closingSteps: rec.closingSteps as string[] }),
      });
    }
    return brands;
  } catch (e) {
    console.warn(`CRM_BRANDS is not a JSON array of track annotation entries (${(e as Error).message}); no descriptions or closing steps are configured`);
    return [];
  }
}

export function crmBrandIds(env: Record<string, string | undefined> = process.env): string[] {
  return crmBrands(env).map((b) => b.id);
}
