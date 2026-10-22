import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  assertApproval: vi.fn(),
  approverFrom: vi.fn(),
  captureOwner: vi.fn(),
  recordRun: vi.fn(),
  runStudioPipeline: vi.fn(),
  gatewayComplete: vi.fn(),
  renderSpread: vi.fn(),
  consensus: vi.fn(),
}));

vi.mock("@lares/agent-kit/db", () => ({ getPool: mocks.getPool }));
vi.mock("../lib/approvals.js", () => ({
  assertApproval: mocks.assertApproval,
  approverFrom: mocks.approverFrom,
}));
vi.mock("../lib/studio/store.js", () => ({
  makeStudioStore: () => ({ captureOwner: mocks.captureOwner, recordRun: mocks.recordRun }),
}));
vi.mock("../lib/llm-complete.js", () => ({ gatewayComplete: mocks.gatewayComplete }));
vi.mock("../lib/studio/atlas-consensus.js", () => ({ makeAtlasConsensus: () => mocks.consensus }));
vi.mock("../lib/studio/pipeline.js", () => ({ runStudioPipeline: mocks.runStudioPipeline }));
vi.mock("../lib/studio/render.js", () => ({ renderSpread: mocks.renderSpread }));

import studioIdeate from "../catalogue/studio_ideate.js";

const approver = { authenticator: "slack-webhook", userId: "U_fixture" };
const run = {
  brief: "private fixture brief",
  consensus: "private grounding",
  spread: [],
};
const context = { session: { auth: { current: null, initiator: null } } } as never;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getPool.mockReturnValue({});
  mocks.assertApproval.mockResolvedValue(undefined);
  mocks.approverFrom.mockReturnValue(approver);
  mocks.renderSpread.mockReturnValue("Rendered fixture spread");
});

describe("studio_ideate ownership boundary", () => {
  it("does not enter the paid pipeline when owner capture refuses", async () => {
    mocks.captureOwner.mockRejectedValue(new Error("authority unavailable"));

    await expect(studioIdeate.execute({ brief: run.brief }, context)).rejects.toThrow("authority unavailable");

    expect(mocks.captureOwner).toHaveBeenCalledWith(approver);
    expect(mocks.runStudioPipeline).not.toHaveBeenCalled();
    expect(mocks.gatewayComplete).not.toHaveBeenCalled();
  });

  it("returns the rendered spread with a safe warning when the history outcome cannot be confirmed", async () => {
    const capture = Object.freeze({});
    mocks.captureOwner.mockResolvedValue(capture);
    mocks.runStudioPipeline.mockResolvedValue(run);
    mocks.recordRun.mockRejectedValue(new Error("private database detail"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await studioIdeate.execute({ brief: run.brief }, context);

      expect(result).toBe("Rendered fixture spread\n\n*I couldn't confirm this run was saved to history.*");
      expect(mocks.runStudioPipeline).toHaveBeenCalledOnce();
      expect(mocks.recordRun).toHaveBeenCalledWith(run, capture);
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("studio: run history save could not be confirmed");
      expect(log.mock.calls.flat().join(" ")).not.toContain(run.brief);
      expect(log.mock.calls.flat().join(" ")).not.toContain("private database detail");
    } finally {
      log.mockRestore();
    }
  });
});
