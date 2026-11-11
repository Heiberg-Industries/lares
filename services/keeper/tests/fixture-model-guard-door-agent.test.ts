// The model guard in the keeper's door-agent fixture, in a process of its own. See fixture-model-guard.shared.ts.
import { vi } from "vitest";
import { describeFixtureGuard } from "./fixture-model-guard.shared.js";

// The keeper does not depend on eve; the fixture's one eve import is stood in for.
vi.mock("eve/instrumentation", () => ({ defineInstrumentation: (definition: unknown) => definition }));

describeFixtureGuard("door-agent");
