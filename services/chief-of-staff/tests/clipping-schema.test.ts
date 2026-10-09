/**
 * LAR-113 — does the Notion database still fit what the source maps? Detection is by property
 * id, so a renamed column still fits and a column that changed type does not.
 */
import { describe, it, expect } from "vitest";

import { checkSchema, ClippingFailure } from "../lib/clipping/notion-reader.js";
import type { ClipSource } from "../lib/clipping/record.js";

const source: ClipSource = {
  id: "s", kind: "notion", dataSourceId: "ds",
  urlPropertyId: "u1", notePropertyId: "n1", tagsPropertyId: "t1", savedPropertyId: "d1",
  owner: "organisation", visibility: "shared",
};

const fits = {
  properties: {
    Name: { id: "title", type: "title" },
    Link: { id: "u1", type: "url" },
    Note: { id: "n1", type: "rich_text" },
    Tags: { id: "t1", type: "select" },
    Saved: { id: "d1", type: "created_time" },
  },
};

function outcomeOf(fn: () => unknown): string | null {
  try { fn(); return null; } catch (e) { return e instanceof ClippingFailure ? e.outcome : "other"; }
}

describe("checkSchema", () => {
  it("accepts a database that fits, with no warnings", () => {
    expect(checkSchema(fits, source)).toEqual({ warnings: [] });
  });

  it("a renamed column still fits (matched by id)", () => {
    const renamed = { properties: { ...fits.properties, "Where to read": fits.properties.Link, Link: undefined } };
    expect(outcomeOf(() => checkSchema(renamed, source))).toBeNull();
  });

  it("refuses when the URL column is gone", () => {
    const { Link: _gone, ...rest } = fits.properties;
    expect(outcomeOf(() => checkSchema({ properties: rest }, source))).toBe("schema-mismatch");
  });

  it("refuses when the URL column changed type", () => {
    const changed = { properties: { ...fits.properties, Link: { id: "u1", type: "rich_text" } } };
    expect(outcomeOf(() => checkSchema(changed, source))).toBe("schema-mismatch");
  });

  it("an optional column that went missing or changed type is a warning, not a stop", () => {
    const drift = {
      properties: {
        Name: fits.properties.Name, Link: fits.properties.Link,
        Tags: { id: "t1", type: "number" },
      },
    };
    const r = checkSchema(drift, source);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings.join(" ")).toMatch(/note/);
    expect(r.warnings.join(" ")).toMatch(/tags/);
    expect(r.warnings.join(" ")).toMatch(/saved-at/);
  });

  it("an optional column that is not mapped is not warned about", () => {
    const bare: ClipSource = { ...source, notePropertyId: null, tagsPropertyId: null, savedPropertyId: null };
    expect(checkSchema({ properties: { Link: fits.properties.Link } }, bare).warnings).toEqual([]);
  });

  it("refuses a response with no column map at all", () => {
    expect(outcomeOf(() => checkSchema({}, source))).toBe("schema-mismatch");
    expect(outcomeOf(() => checkSchema(null, source))).toBe("schema-mismatch");
  });
});
