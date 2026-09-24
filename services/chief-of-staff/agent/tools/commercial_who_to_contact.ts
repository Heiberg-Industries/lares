// Surface the top CRM contacts to reach out to, ranked by ICP fit and relationship warmth.
// Read-only, UNGATED — matches the old hand exactly (`writes: []`).
//
// Ported from `services/agent-runtime/lib/adapters/hands/commercial.ts` (the thin hand) +
// the `commercial` entry in `integrations/` (the wiring this file replaces, since eve-saga
// has no integration-registry layer).
//
// This is THE gated surface `listPeople` is meant to be reached through (Task 5's deliberate
// exclusion of `listPeople` as a standalone tool — "the full-contact-dump guard"): the model
// never sees the raw Twenty dump, only `surfaceCommercial`'s scored, filtered, top-8-per-brand
// output.
//
// ORB-51 degrade posture (proven in tests/commercial.test.ts): Orakel and the LLM (`think`)
// are best-effort per `lib/commercial/surface.ts`'s own try/catch — an outage there degrades
// ONE contact's enrichment, never the whole call. `listPeople` and `getCompanyForPerson` are
// real Twenty reads with NO try/catch here or in `surface.ts` — a genuine
// `TwentyUnavailableError` propagates out of this tool rather than silently returning an
// empty or wrong result.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { resolveSkillTool } from "@lares/agent-kit/manifest";

import manifest from "../../agent.json";
import { listPeopleCapped } from "../../lib/twenty-people.js";
import { icpFor } from "../../lib/commercial/icp.js";
import { gatewayComplete } from "../../lib/llm-complete.js";
import { twentyCompanyForPerson } from "../../catalogue/twenty_company_for_person.js";
import { orakelSearch } from "../../lib/orakel-client.js";
import {
  surfaceCommercial,
  type SurfaceDeps,
  type SurfacedContact,
} from "../../lib/commercial/surface.js";

const DEFAULT_BRANDS = ["zero7", "orakel", "heiberg"];

function configuredBrands(): string[] {
  const raw = process.env["COMMERCIAL_BRANDS"];
  if (!raw) return DEFAULT_BRANDS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((b) => typeof b === "string") && parsed.length > 0) {
      return parsed;
    }
  } catch {
    // fall through to default
  }
  console.warn(`commercial_who_to_contact: COMMERCIAL_BRANDS="${raw}" is not a JSON string array; using default`);
  return DEFAULT_BRANDS;
}

/** Resolve a person's linked company name via Twenty. Returns null for the two legitimate
 *  "no company" outcomes (not found / no linked company); a genuine `TwentyUnavailableError`
 *  is NOT caught here — it propagates, per this file's own ORB-51 header. */
async function getCompanyForPerson(personId: string): Promise<string | null> {
  const company = await twentyCompanyForPerson(personId);
  return "ok" in company ? null : company.name;
}

/** Best-effort Orakel enrichment by company name search — first hit only. Errors propagate
 *  to `surface.ts`'s own try/catch around this call, which is what makes an Orakel outage
 *  degrade only this one contact's enrichment rather than the whole tool call. */
async function orakelEnrich(companyName: string): Promise<Record<string, unknown> | null> {
  const results = await orakelSearch(companyName, { limit: 1 });
  const first = results[0];
  if (!first) return null;
  return {
    orgNumber: first.orgNumber,
    employees: first.employeeCount,
    industry: first.naceName,
    size: first.sizeClass,
  };
}

function liveDeps(): SurfaceDeps {
  const orakelConfigured = Boolean(process.env["ORAKEL_URL"]?.trim());
  return {
    listPeople: () => listPeopleCapped({ cap: 2000 }),
    icpFor,
    think: (prompt) =>
      gatewayComplete(prompt, { model: process.env["COMMERCIAL_MODEL"], purpose: "brain", maxOutputTokens: 256 }),
    getCompanyForPerson,
    orakelEnrich: orakelConfigured ? orakelEnrich : undefined,
    // opportunitiesForPerson intentionally left unwired — matching the old registry's own
    // production wiring, which never set it either (SurfaceDeps treats it as a fully
    // optional pipeline-annotation extra).
    brands: configuredBrands(),
    now: () => new Date(),
    sweepMax: Number(process.env["COMMERCIAL_SWEEP_MAX"] ?? "200"),
  };
}

const tool = defineTool({
  description:
    "Surface the top CRM contacts to reach out to, ranked by ICP fit and relationship warmth. " +
    "Optionally filter to a single brand with the `brand` argument (e.g. \"orakel\", \"zero7\", \"heiberg\"). " +
    "Returns a per-brand map of up to 8 contacts with name, email, score, and a short reason. " +
    "Read-only, ungated.",
  inputSchema: z.object({ brand: z.string().optional() }),
  async execute({ brand }): Promise<Record<string, SurfacedContact[]>> {
    const allByBrand = await surfaceCommercial(liveDeps(), "subset");
    if (brand === undefined) return allByBrand;
    return brand in allByBrand ? { [brand]: allByBrand[brand]! } : {};
  },
});

export default resolveSkillTool(manifest, "commercial", tool);
