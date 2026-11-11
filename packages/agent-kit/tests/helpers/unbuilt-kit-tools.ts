/**
 * Stand-in for `@lares/agent-kit/tools` while the kit has not been built (its `dist/` does not exist on
 * this branch until the kit builds). The two catalogue entries `catalogue/agent-kit__*.ts` import these. Used
 * ONLY by each service's `vitest.unbuilt-kit.config.ts`; once the kit builds, run the plain config.
 */
export { default as signals_recent } from "../../extension/tools/signals_recent.js";
export { default as transit_plan } from "../../extension/tools/transit_plan.js";
