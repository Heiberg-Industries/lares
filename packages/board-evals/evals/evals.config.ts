import { defineEvalConfig } from "eve/evals";

// All required evals share one local dev process and explicitly mutate synthetic control files.
// Serialize them so a definition/board update belongs only to the eval that made it. The
// outer runner gives each batch a fresh app/workflow world, with no shared repository history.
export default defineEvalConfig({ maxConcurrency: 1 });
