import { describe, it, expect } from "vitest";
import { GATEWAY_PURPOSES, purposeModel } from "../src/gateway-status.js";

describe("purposeModel", () => {
  it("joins the installation's prefix and the purpose", () => {
    expect(purposeModel("brain", { LARES_MODEL_PREFIX: "lares" })).toBe("lares-brain");
    for (const purpose of GATEWAY_PURPOSES)
      expect(purposeModel(purpose, { LARES_MODEL_PREFIX: "home" })).toBe(`home-${purpose}`);
  });

  it("reads the process environment by default", () => {
    const before = process.env["LARES_MODEL_PREFIX"];
    process.env["LARES_MODEL_PREFIX"] = "home";
    try {
      expect(purposeModel("embed")).toBe("home-embed");
    } finally {
      if (before === undefined) delete process.env["LARES_MODEL_PREFIX"];
      else process.env["LARES_MODEL_PREFIX"] = before;
    }
  });

  it("says plainly that the prefix is missing, rather than guessing a name", () => {
    expect(() => purposeModel("writer", {})).toThrow(/LARES_MODEL_PREFIX is not set/);
    expect(() => purposeModel("writer", { LARES_MODEL_PREFIX: "" })).toThrow(/LARES_MODEL_PREFIX is not set/);
  });
});
