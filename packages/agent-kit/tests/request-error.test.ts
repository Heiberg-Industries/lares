import { describe, it, expect } from "vitest";
import {
  REQUEST_ERROR_KINDS, RequestError, isRequestError, isRetryable, kindForStatus, retryAfterSeconds,
} from "../src/request-error.js";

describe("the four kinds", () => {
  it("is exactly ADR-0019 rule 2's four", () => {
    expect([...REQUEST_ERROR_KINDS]).toEqual(["down", "not_authorised", "rate_limited", "not_subscribed"]);
  });

  it("carries the integration and never the URL", () => {
    const e = new RequestError("down", "frankfurter is unreachable", { integration: "frankfurter", status: 503 });
    expect(isRequestError(e)).toBe(true);
    expect(e.kind).toBe("down");
    expect(e.integration).toBe("frankfurter");
    expect(e.name).toBe("RequestError");
    expect(e instanceof Error).toBe(true);
  });

  it("only down and rate_limited are worth retrying", () => {
    const of = (k: never) => new RequestError(k, "x", { integration: "i" });
    expect(isRetryable(of("down" as never))).toBe(true);
    expect(isRetryable(of("rate_limited" as never))).toBe(true);
    expect(isRetryable(of("not_authorised" as never))).toBe(false);
    expect(isRetryable(of("not_subscribed" as never))).toBe(false);
    expect(isRetryable(new Error("something else"))).toBe(false);
  });
});

describe("kindForStatus", () => {
  it("maps the unambiguous ones", () => {
    expect(kindForStatus(200)).toBeUndefined();
    expect(kindForStatus(204)).toBeUndefined();
    expect(kindForStatus(401)).toBe("not_authorised");
    expect(kindForStatus(429)).toBe("rate_limited");
    expect(kindForStatus(408)).toBe("down");
    expect(kindForStatus(500)).toBe("down");
    expect(kindForStatus(503)).toBe("down");
    expect(kindForStatus(402)).toBe("not_subscribed");
  });

  it("splits 403 on what the body says, and defaults to not_authorised", () => {
    expect(kindForStatus(403, '{"error":"your plan does not include this endpoint"}')).toBe("not_subscribed");
    expect(kindForStatus(403, '{"error":"upgrade required"}')).toBe("not_subscribed");
    expect(kindForStatus(403, '{"error":"insufficient scope"}')).toBe("not_authorised");
    expect(kindForStatus(403)).toBe("not_authorised");
  });

  it("leaves an ordinary 4xx to the caller", () => {
    expect(kindForStatus(400)).toBeUndefined();
    expect(kindForStatus(404)).toBeUndefined();
    expect(kindForStatus(422)).toBeUndefined();
  });
});

describe("retryAfterSeconds", () => {
  const now = new Date("2026-09-18T10:00:00Z");
  it("reads the delta form", () => expect(retryAfterSeconds("30", now)).toBe(30));
  it("reads the HTTP-date form", () => expect(retryAfterSeconds("Fri, 18 Sep 2026 10:00:45 GMT", now)).toBe(45));
  it("clamps a past date to zero rather than returning a negative", () => {
    expect(retryAfterSeconds("Fri, 18 Sep 2026 09:59:00 GMT", now)).toBe(0);
  });
  it("is undefined when absent or unreadable", () => {
    expect(retryAfterSeconds(null, now)).toBeUndefined();
    expect(retryAfterSeconds("soon", now)).toBeUndefined();
  });
});
