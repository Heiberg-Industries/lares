import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_DISCOVERY_MAX_AGE, openOwnerDiscoveryReceipt, ownerDiscoveryDigest,
  parseOwnerBootstrapSelection, sealOwnerDiscoveryReceipt, selectionFromDiscovery,
} from "../lib/owner-bootstrap-receipt";

const identity = { issuer: "https://accounts.google.com", subject: `exact\"subject$\n`, tenantId: "tenant's exact value" };
const receipt = { installationOrigin: "https://example.test", identity, digest: ownerDiscoveryDigest("https://example.test", identity) };
const selection = selectionFromDiscovery(receipt, "stable-owner", "example.test");

beforeEach(() => { vi.stubEnv("CONSOLE_SESSION_SECRET", "test-session-secret"); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("first-owner discovery receipt", () => {
  it("round-trips the exact opaque provider tuple in a purpose-bound short-lived cookie", async () => {
    const token = await sealOwnerDiscoveryReceipt(receipt);
    expect(await openOwnerDiscoveryReceipt(token)).toEqual(receipt);
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(payload).toMatchObject({
      iss: "lares-console-owner-discovery", aud: "lares-console-owner-discovery-display",
      installationOrigin: "https://example.test", identity,
    });
    expect(payload).not.toHaveProperty("ownerId"); expect(payload).not.toHaveProperty("organisationId");
    vi.advanceTimersByTime((OWNER_DISCOVERY_MAX_AGE + 1) * 1000);
    expect(await openOwnerDiscoveryReceipt(token)).toBeNull();
  });

  it("rejects a tampered token and an edited owner/org/identity envelope", async () => {
    const token = await sealOwnerDiscoveryReceipt(receipt);
    expect(await openOwnerDiscoveryReceipt(`${token.slice(0, -1)}x`)).toBeNull();
    expect(() => parseOwnerBootstrapSelection({ ...selection, organisationId: "other.test" })).toThrow();
    expect(() => parseOwnerBootstrapSelection({ ...selection, identity: { ...identity, subject: "other" } })).toThrow();
    expect(() => parseOwnerBootstrapSelection({ ...selection, extra: "unexpected" })).toThrow();
  });
});
