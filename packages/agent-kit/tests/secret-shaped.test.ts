import { describe, expect, it } from "vitest";
import { looksLikeSecret } from "../src/secret-shaped.js";

// Made-up random strings, never real keys.
const RANDOM = "q7Zx1Lm9Tr4Vb8Nc2Wd5Ye3Hf6Jg0Ks";

describe("looksLikeSecret", () => {
  it("catches a long unbroken random run and a word-prefixed random tail", () => {
    expect(looksLikeSecret(RANDOM)).toBe(true);
    expect(looksLikeSecret(`sk_${RANDOM}`)).toBe(true);
    expect(looksLikeSecret(`token-${RANDOM}`)).toBe(true);
    expect(looksLikeSecret(`  ${RANDOM}  `)).toBe(true);
  });
  it("lets ordinary tool names through", () => {
    for (const name of ["find_rate", "get_ownership_network", "search_companies", "fetch_financial_history", "list_rates_v2",
      "searchCompanyByOrganisationNumber", "get", "push_to_destination"]) expect(looksLikeSecret(name)).toBe(false);
  });
});
