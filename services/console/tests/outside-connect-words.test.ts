import { describe, expect, it } from "vitest";
import { suggestConnectionName, toolNamesOf, uniqueConnectionName } from "../lib/outside-connect-words";

describe("outside connect wording helpers", () => {
  it("suggests a short name from the server address", () => {
    expect(suggestConnectionName("https://tools.example.org/api/mcp")).toBe("example");
    expect(suggestConnectionName("https://registry.fly.dev/mcp")).toBe("registry");
    expect(suggestConnectionName("https://api.mcp.Rates-Hub.co.uk/v1")).toBe("rates-hub");
    expect(suggestConnectionName("https://www.mcp.com/")).toBe("www");
    expect(suggestConnectionName("https://203.0.113.7:8080/mcp")).toBe("t-203");
    expect(suggestConnectionName("https://xn--bcher-kva.example/mcp")).toBe("xn--bcher-kva");
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
  it("makes the name unique when another connection has it", () => {
    expect(uniqueConnectionName("example", [])).toBe("example");
    expect(uniqueConnectionName("example", ["other"])).toBe("example");
    expect(uniqueConnectionName("example", ["example"])).toBe("example-2");
    expect(uniqueConnectionName("example", ["example", "example-2"])).toBe("example-3");
    const long = "a".repeat(31);
    const made = uniqueConnectionName(long, [long]);
    expect(made).toMatch(/^[a-z][a-z0-9-]{1,30}$/); expect(made).not.toBe(long);
    expect(uniqueConnectionName("", ["x"])).toBe("");
  });
  it("splits typed tool names once each", () => {
    expect(toolNamesOf("find_rate, list_rates  find_rate\nget")).toEqual(["find_rate", "list_rates", "get"]);
    expect(toolNamesOf("  ")).toEqual([]);
  });
});

import { parseOutsideDiscoveryDocument } from "../lib/outside-discovery-dto";
describe("discovery document read-only hint", () => {
  const doc = (tool: Record<string, unknown>) => ({ protocolVersion: "2025-06-18", serverInfo: { name: "S", version: "1" }, tools: [{ name: "a", inputSchema: {}, ...tool }] });
  it("keeps a true read-only hint and refuses any other value", () => {
    expect(parseOutsideDiscoveryDocument(doc({ readOnly: true }))?.tools[0]?.readOnly).toBe(true);
    expect(parseOutsideDiscoveryDocument(doc({}))?.tools[0]).not.toHaveProperty("readOnly");
    expect(parseOutsideDiscoveryDocument(doc({ readOnly: false }))).toBeUndefined();
  });
});
