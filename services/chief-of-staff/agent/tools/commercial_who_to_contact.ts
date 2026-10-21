// Surface the top CRM contacts to reach out to, ranked by ICP fit and relationship warmth.
// Read-only, UNGATED (`writes: []`).
//
// This is THE gated surface `listPeople` is meant to be reached through (the deliberate
// exclusion of `listPeople` as a standalone tool — "the full-contact-dump guard"): the model
// never sees the raw Twenty dump, only `surfaceCommercial`'s scored, filtered, top-8-per-brand
// output.
//
// degrade posture (proven in tests/commercial.test.ts): the LLM (`think`)
// is best-effort per `lib/commercial/surface.ts`'s own try/catch — an outage there degrades
// ONE contact's scoring, never the whole call. `listPeople` and `getCompanyForPerson` are
// real Twenty reads with NO try/catch here or in `surface.ts` — a genuine
// `TwentyUnavailableError` propagates out of this tool rather than silently returning an
// empty or wrong result.
import { verifyPrivateConsoleSession, assertPrivateConsoleTool } from "@lares/agent-kit/private-console-surface";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { resolveSkillTool } from "@lares/agent-kit/manifest";

import manifest from "../../agent.json";
import { listPeopleCapped } from "../../lib/twenty-people.js";
import { icpFor } from "../../lib/commercial/icp.js";
import { gatewayComplete } from "../../lib/llm-complete.js";
import { twentyCompanyForPerson } from "../../catalogue/twenty_company_for_person.js";
import {
  surfaceCommercial,
  type SurfaceDeps,
  type SurfacedContact,
} from "../../lib/commercial/surface.js";

// Installation data: the brands (names of ICP files on disk) come from COMMERCIAL_BRANDS. Unset
// means none, and the tool says so rather than guessing.
const DEFAULT_BRANDS: string[] = [];

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
 *  is NOT caught here — it propagates, per this file's own header. */
async function getCompanyForPerson(personId: string): Promise<string | null> {
  const company = await twentyCompanyForPerson(personId);
  return "ok" in company ? null : company.name;
}

function liveDeps(): SurfaceDeps {
  return {
    listPeople: () => listPeopleCapped({ cap: 2000 }),
    icpFor,
    think: (prompt) =>
      gatewayComplete(prompt, { model: process.env["COMMERCIAL_MODEL"], purpose: "brain", maxOutputTokens: 256 }),
    getCompanyForPerson,
    // opportunitiesForPerson intentionally left unwired (SurfaceDeps treats it as a fully
    // optional pipeline-annotation extra).
    brands: configuredBrands(),
    now: () => new Date(),
    sweepMax: Number(process.env["COMMERCIAL_SWEEP_MAX"] ?? "200"),
  };
}

const tool = defineTool({
  description:
    "Surface the top CRM contacts to reach out to, ranked by ICP fit and relationship warmth. " +
    "Optionally filter to a single brand with the `brand` argument (one of the brands configured for this installation). " +
    "Returns a per-brand map of up to 8 contacts with name, email, score, and a short reason. " +
    "Read-only, ungated.",
  inputSchema: z.object({ brand: z.string().optional() }),
  async execute({ brand }, ctx): Promise<Record<string, SurfacedContact[]>> {
    assertPrivateConsoleTool(ctx, "chief-of-staff", "commercial_who_to_contact");
    const allByBrand = await surfaceCommercial(liveDeps(), "subset");
    if (brand === undefined) return allByBrand;
    return brand in allByBrand ? { [brand]: allByBrand[brand]! } : {};
  },
});

export default defineDynamic({ events: { "session.started": async (_event, ctx) => {
  if (await verifyPrivateConsoleSession(ctx)) return null;
  const resolved = resolveSkillTool(manifest, "commercial", tool);
  return "execute" in resolved ? resolved : null;
} } });
