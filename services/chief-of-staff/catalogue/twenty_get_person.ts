// Read a single CRM person by record id. Read-only HTTP against TWENTY_BASE_URL.
//
// Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`'s `getPersonImpl`.
//
// ORB-51 posture: the old client returned `null` for BOTH a real 404 and a genuine network
// failure (`getOrNull` treats any non-404 error path the same as a legitimate miss further
// up). The hand's own description already treats "not found" as a normal, expected outcome
// ("...or a not-found note") — that stays a returned value here. What changes is that a
// `TwentyUnavailableError` (network failure, non-404 HTTP error) is no longer swallowed into
// the same shape: it propagates, because a backend failure is not a valid tool result.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { twentyGet, TwentyNotFoundError } from "../lib/twenty-client.js";

export interface TwentyCrmPerson {
  recordId: string;
  firstName: string;
  lastName: string;
  emails: string[];
  role: string | null;
  linkedinUrl: string | null;
  companyId: string | null;
}
export type TwentyPersonNotFound = { ok: false; reason: "not found" };

/** Shared with `twenty_company_for_person.ts` so it doesn't re-implement this fetch. */
export async function fetchTwentyPerson(
  recordId: string,
): Promise<TwentyCrmPerson | TwentyPersonNotFound> {
  let body: { data?: { person?: any } };
  try {
    body = await twentyGet<{ data?: { person?: any } }>(`/people/${recordId}`);
  } catch (err) {
    if (err instanceof TwentyNotFoundError) return { ok: false, reason: "not found" };
    throw err;
  }
  const r = body?.data?.person;
  if (!r) return { ok: false, reason: "not found" };
  const primary = r?.emails?.primaryEmail ?? null;
  return {
    recordId: r?.id ?? recordId,
    firstName: r?.name?.firstName ?? "",
    lastName: r?.name?.lastName ?? "",
    emails: primary ? [primary] : [],
    role: r?.jobTitle ?? null,
    linkedinUrl: r?.linkedinLink?.primaryLinkUrl ?? null,
    companyId: r?.companyId ?? null,
  };
}

export default defineTool({
  description:
    "Read a CRM person by record id — read-only HTTP call to TWENTY_BASE_URL. Returns " +
    "name, emails, role, LinkedIn, and the linked company id — or a not-found note (a " +
    "real, expected outcome). TwentyUnavailableError is thrown only on a genuine " +
    "transport/HTTP failure against Twenty.",
  inputSchema: z.object({ recordId: z.string() }),
  async execute({ recordId }) {
    return fetchTwentyPerson(recordId);
  },
});
