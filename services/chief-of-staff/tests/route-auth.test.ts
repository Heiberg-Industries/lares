import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { purposeRequest } = vi.hoisted(() => ({ purposeRequest: vi.fn() }));
vi.mock("@lares/agent-kit/model-purpose-client", () => ({ modelPurposeRequest: purposeRequest }));
vi.mock("@lares/agent-kit/vault-broker-client", () => ({ vaultBrokerRequest: vi.fn(async () => { throw new Error("optional broker absent"); }) }));
vi.mock("@lares/agent-kit/console-turn-authority", () => ({
  consoleRouteAdmission: vi.fn(async (request: Request) => {
    const purpose = request.headers.get("x-lares-purpose") ?? "human";
    if (purpose === "resolver") {
      const body = await request.clone().json() as { inputResponses?: Array<{ requestId?: string; optionId?: string }> };
      return { lares_resolver_member_id: request.headers.get("x-lares-member-id") ?? "member-1",
        lares_resume_request_id: body.inputResponses?.[0]?.requestId ?? "approval-card",
        lares_resume_option: body.inputResponses?.[0]?.optionId ?? "approve", lares_purpose: purpose };
    }
    return { lares_member_id: request.headers.get("x-lares-member-id") ?? "member-1",
      lares_admission_nonce: request.headers.get("x-lares-admission") ?? "n".repeat(43), lares_purpose: purpose };
  }),
  consoleAdmission: (auth: { authenticator?: string; attributes?: Record<string, unknown> } | undefined) => {
    const a = auth?.attributes;
    return auth?.authenticator === "lares-console" && typeof a?.lares_member_id === "string" && typeof a.lares_admission_nonce === "string"
      ? { memberId: a.lares_member_id, admissionNonce: a.lares_admission_nonce, purpose: a.lares_purpose }
      : undefined;
  },
}));

// The password is read on first REQUEST, cached per process — so each test needs a fresh
// module instance to isolate its secret file, exactly as the gateway-provider tests do.
async function freshAuth() {
  vi.resetModules();
  return (await import("../agent/channels/eve.js")).basicFromSecretFile;
}

function basic(user: string, pass: string): Request {
  const encoded = Buffer.from(`${user}:${pass}`).toString("base64");
  return new Request("https://chief-of-staff.test/eve/v1/session", {
    method: "POST",
    headers: { authorization: `Basic ${encoded}` },
  });
}

describe("chief-of-staff route auth", () => {
  let dir: string;
  let pwPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chief-of-staff-routeauth-"));
    pwPath = join(dir, "route-password");
    writeFileSync(pwPath, "s3cret-route-password\n", "utf8");
    process.env["EVE_ROUTE_PASSWORD_FILE"] = pwPath;
  });

  afterEach(() => {
    purposeRequest.mockReset();
    rmSync(dir, { recursive: true, force: true });
    delete process.env["EVE_ROUTE_PASSWORD_FILE"];
  });

  it("accepts the correct credential (trailing newline in the secret file is trimmed)", async () => {
    const auth = await freshAuth();
    const result = await auth(basic("eve", "s3cret-route-password"));
    expect(result).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    const auth = await freshAuth();
    expect(await auth(basic("eve", "wrong"))).toBeFalsy();
  });

  it("rejects a wrong username even with the right password", async () => {
    const auth = await freshAuth();
    expect(await auth(basic("someone-else", "s3cret-route-password"))).toBeFalsy();
  });

  it("rejects a request with no Authorization header — this is the production default", async () => {
    const auth = await freshAuth();
    const bare = new Request("https://chief-of-staff.test/eve/v1/session", { method: "POST" });
    expect(await auth(bare)).toBeFalsy();
  });

  // An empty secret file must NOT degrade into "anyone sending an empty password gets in".
  // Failing loudly is the only safe reading of an empty credential.
  it("throws on an empty secret file rather than authenticating an empty password", async () => {
    writeFileSync(pwPath, "\n", "utf8");
    const auth = await freshAuth();
    await expect(async () => auth(basic("eve", ""))).rejects.toThrow(/secret file is empty/);
  });

  it("throws a path-only error when the secret file is missing", async () => {
    process.env["EVE_ROUTE_PASSWORD_FILE"] = join(dir, "does-not-exist");
    const auth = await freshAuth();
    await expect(async () => auth(basic("eve", "whatever"))).rejects.toThrow(
      `secret file not readable: ${join(dir, "does-not-exist")}`,
    );
  });

  // Regression guard for the trap already paid for once in lib/gateway-provider.ts: `eve build`
  // evaluates this module, and a build has no secrets. Importing it must touch no file.
  it("reads nothing at import — a credential-free build must work", async () => {
    process.env["EVE_ROUTE_PASSWORD_FILE"] = join(dir, "does-not-exist");
    await expect(freshAuth()).resolves.toBeTypeOf("function");
  });

  it("keeps tagged human chat working when optional model-purpose custody is absent", async () => {
    const { basicFromSecretFile, onPrivateConsoleMessage } = await import("../agent/channels/eve.js");
    const body = '{"message":"ordinary private chat"}';
    const request = new Request("https://chief-of-staff.test/eve/v1/session/session-1", { method: "POST", body,
      headers: { authorization: `Basic ${Buffer.from(`eve:s3cret-route-password`).toString("base64")}`,
        "x-lares-member-id": "member-1", "x-lares-admission": "n".repeat(43), "x-lares-purpose": "human" } });
    const auth = await basicFromSecretFile(request);
    expect(auth).toMatchObject({ authenticator: "lares-console", attributes: { lares_purpose: "human" } });
    const parsed = JSON.parse(body);
    await expect(onPrivateConsoleMessage({ eve: { caller: auth as never, request } }, parsed.message)).resolves.toMatchObject({ auth: expect.any(Object) });
    expect(purposeRequest).not.toHaveBeenCalled();
  });

  it("keeps an authenticated approval resume working when optional custody is absent", async () => {
    const { basicFromSecretFile } = await import("../agent/channels/eve.js");
    const request = new Request("https://chief-of-staff.test/eve/v1/session/session-1", { method: "POST",
      body: '{"inputResponses":[{"requestId":"approval-card","optionId":"approve"}]}',
      headers: { authorization: `Basic ${Buffer.from(`eve:s3cret-route-password`).toString("base64")}`,
        "x-lares-member-id": "member-1", "x-lares-admission": "n".repeat(43), "x-lares-purpose": "resolver" } });
    await expect(basicFromSecretFile(request)).resolves.toMatchObject({ authenticator: "lares-console", attributes: {
      lares_resolver_member_id: "member-1", lares_resume_request_id: "approval-card", lares_resume_option: "approve",
    } });
    expect(purposeRequest).not.toHaveBeenCalled();
  });

  it("admits the exact raw human receipt in onMessage and the approval receipt in onRequest", async () => {
    const { basicFromSecretFile, onPrivateConsoleMessage } = await import("../agent/channels/eve.js");
    purposeRequest.mockResolvedValue({ pendingReceipt: "p".repeat(43) });
    const payload = (request: Record<string, unknown>) => `${Buffer.from(JSON.stringify({ version: 1, request })).toString("base64url")}.signature`;
    const authHeaders = (purpose: string) => ({ authorization: `Basic ${Buffer.from(`eve:s3cret-route-password`).toString("base64")}`,
      "x-lares-member-id": "member-1", "x-lares-admission": "n".repeat(43), "x-lares-purpose": purpose,
      "x-lares-model-purpose-required": "1" });

    const humanBody = '{"message":"exact raw human"}';
    const humanCapsule = payload({ purpose: "human", requestId: "h".repeat(43) });
    const humanRequest = new Request("https://chief-of-staff.test/eve/v1/session/session-1", { method: "POST", body: humanBody,
      headers: { ...authHeaders("human"), "x-lares-model-capsule": humanCapsule } });
    const humanAuth = await basicFromSecretFile(humanRequest);
    expect(humanAuth).toMatchObject({ authenticator: "lares-console", attributes: { lares_model_purpose_required: "1" } });
    const message = JSON.parse(humanBody).message;
    await onPrivateConsoleMessage({ eve: { caller: humanAuth as never, request: humanRequest } }, message);
    expect(purposeRequest).toHaveBeenLastCalledWith("request.admit", expect.objectContaining({
      receipt: expect.objectContaining({ method: "POST", path: "/eve/v1/session/session-1", requestId: "h".repeat(43), purpose: "human" }),
    }));

    purposeRequest.mockClear();
    const responseBody = '{"inputResponses":[{"requestId":"approval-card","optionId":"approve"}]}';
    const responseCapsule = payload({ purpose: "resume", requestId: "m".repeat(43), resume: { requestId: "approval-card", optionId: "approve" } });
    const responseRequest = new Request("https://chief-of-staff.test/eve/v1/session/session-1", { method: "POST", body: responseBody,
      headers: { ...authHeaders("resolver"), "x-lares-model-capsule": responseCapsule } });
    const responseAuth = await basicFromSecretFile(responseRequest);
    expect(responseAuth).toMatchObject({ authenticator: "lares-console", attributes: {
      lares_model_purpose_required: "1", lares_model_pending_receipt: "p".repeat(43),
      lares_resolver_member_id: "member-1", lares_resume_request_id: "approval-card",
    } });
    expect(purposeRequest).toHaveBeenCalledWith("request.admit", expect.objectContaining({
      receipt: expect.objectContaining({ method: "POST", path: "/eve/v1/session/session-1", requestId: "m".repeat(43), purpose: "resume",
        resume: { requestId: "approval-card", optionId: "approve" } }),
    }));
  });

  it("refuses a marked model-purpose request if its capsule is missing", async () => {
    const { basicFromSecretFile } = await import("../agent/channels/eve.js");
    const request = new Request("https://chief-of-staff.test/eve/v1/session/session-1", { method: "POST", body: '{"message":"hello"}',
      headers: { authorization: `Basic ${Buffer.from(`eve:s3cret-route-password`).toString("base64")}`,
        "x-lares-member-id": "member-1", "x-lares-admission": "n".repeat(43), "x-lares-purpose": "human",
        "x-lares-model-purpose-required": "1" } });
    await expect(basicFromSecretFile(request)).resolves.toBeNull();
  });
});
