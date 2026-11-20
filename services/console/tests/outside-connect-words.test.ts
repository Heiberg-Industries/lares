import { describe, expect, it } from "vitest";
import { suggestConnectionName, toolNamesOf } from "../lib/outside-connect-words";

describe("outside connect wording helpers", () => {
  it("suggests a short name from the server address", () => {
    expect(suggestConnectionName("https://tools.example.org/api/mcp")).toBe("example");
    expect(suggestConnectionName("https://mcp.example.com/")).toBe("example");
    expect(suggestConnectionName("https://example.com/mcp")).toBe("example");
    expect(suggestConnectionName("http://localhost:3000/mcp")).toBe("localhost");
    expect(suggestConnectionName("not a url")).toBe("");
  });
  it("always gives a name the keeper accepts, or nothing", () => {
    for (const address of ["https://123.example.org/mcp", "https://a.b/mcp", "https://x/mcp", "https://very-long-name-that-goes-on-and-on-forever-and-ever.example.org/"]) {
      const name = suggestConnectionName(address);
      expect(name === "" || /^[a-z][a-z0-9-]{1,30}$/.test(name)).toBe(true);
    }
  });
  it("splits typed tool names once each", () => {
    expect(toolNamesOf("find_rate, list_rates  find_rate\nget")).toEqual(["find_rate", "list_rates", "get"]);
    expect(toolNamesOf("  ")).toEqual([]);
  });
});
