/**
 * The brands an installation tracks in its CRM — installation data, never engine code.
 *
 * `CRM_BRANDS` is a JSON array of `{ "id": "EXAMPLE_BRAND", "description": "one line" }`. The
 * `id` is the member of the CRM's Opportunity.brand select (upper case, exactly as the CRM spells
 * it); the `description` is what the routing classifier is told about the brand. Unset or
 * invalid means NO brands: routing proposes nothing, and a hand-made opportunity is passed to
 * the CRM as written, which validates it.
 */
export interface CrmBrand {
  id: string;
  description: string;
}

export function crmBrands(env: Record<string, string | undefined> = process.env): CrmBrand[] {
  const raw = env["CRM_BRANDS"];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const brands: CrmBrand[] = [];
    for (const item of parsed) {
      const rec = item as { id?: unknown; description?: unknown };
      if (typeof rec?.id !== "string" || rec.id.trim() === "") throw new Error("an entry has no id");
      brands.push({
        id: rec.id.trim().toUpperCase(),
        description: typeof rec.description === "string" ? rec.description.trim() : "",
      });
    }
    return brands;
  } catch (e) {
    console.warn(`CRM_BRANDS is not a JSON array of { id, description } (${(e as Error).message}); no brands are configured`);
    return [];
  }
}

export function crmBrandIds(env: Record<string, string | undefined> = process.env): string[] {
  return crmBrands(env).map((b) => b.id);
}
