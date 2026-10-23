import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owner: vi.fn(), member: vi.fn(), verify: vi.fn(), invite: vi.fn(), revoke: vi.fn(), remove: vi.fn(), signOut: vi.fn(), keeper: vi.fn(), clear: vi.fn(), setInitialLimit: vi.fn(), cookie: 'opaque-session-cookie' }));
vi.mock("../lib/auth", () => ({ requireConsoleMember: mocks.owner, requireMember: mocks.member, verify: mocks.verify, members: { inviteMember: mocks.invite, revokeInvitation: mocks.revoke, signOutAll: mocks.signOut } }));
vi.mock("../lib/keeper-client", () => ({ keeper: mocks.keeper, KeeperRefusedError: class KeeperRefusedError extends Error {}, KeeperUnavailableError: class KeeperUnavailableError extends Error { constructor(message:string,readonly outcomeMayBeUnknown=false){super(message);} } }));
vi.mock("../lib/console-oidc", () => ({ consoleRedirect: () => "https://console.example.test/api/auth/callback" }));
vi.mock("../lib/initial-member-budget", () => ({ InitialMemberBudgetRefused: class InitialMemberBudgetRefused extends Error { constructor(readonly reason:string){super("refused");} }, setInitialMemberBudgetLimit:mocks.setInitialLimit }));
vi.mock("../lib/db", () => ({ pool: {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ delete: mocks.clear, get: (name:string) => name==='lares_session'?{value:mocks.cookie}:undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
import { createInvitation, revokeInvitation, removeMember, signOutEverywhere, signOutMember, setInitialMemberLimit } from "../app/actions/members";
import {KeeperUnavailableError} from "../lib/keeper-client";
const form = (values: Record<string, string>) => { const result = new FormData(); for (const [key, value] of Object.entries(values)) result.set(key, value); return result; };
beforeEach(() => {
  vi.clearAllMocks(); mocks.owner.mockReset().mockResolvedValue({ id: "owner" }); mocks.member.mockReset().mockResolvedValue({ id: "second" });
  mocks.verify.mockReset().mockResolvedValue('owner@example.test');
  mocks.invite.mockReset().mockResolvedValue({ token: "a".repeat(43) });
  mocks.keeper.mockReset().mockResolvedValue({removed:true});
  mocks.setInitialLimit.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("member management current-actor boundaries", () => {
  it("creates and returns a one-use link without sending mail or treating email as identity", async () => {
    const result = await createInvitation({}, form({ displayName: "Example", email: "member@example.test", role: "member", actorId: "attacker" }));
    expect(result.url).toBe(`https://console.example.test/invite?token=${"a".repeat(43)}`);
    expect(mocks.invite).toHaveBeenCalledWith("owner", { displayName: "Example", email: "member@example.test", role: "member", expiresAt: expect.any(Date) });
  });
  it("submits only the server cookie, target and explicit member limit to the owner-only Keeper action",async()=>{
    const result=await setInitialMemberLimit({},form({memberId:"target",monthlyLimit:"25.5",actorId:"forged-owner",sessionToken:"forged-cookie"}));
    expect(result).toEqual({saved:true});
    expect(mocks.setInitialLimit).toHaveBeenCalledWith({sessionToken:mocks.cookie,targetMemberId:"target",monthlyLimit:"25.5"},'owner');
  });
  it("shows honest unavailable and unknown-outcome messages without repeating a write",async()=>{
    mocks.setInitialLimit.mockRejectedValueOnce(new KeeperUnavailableError("unknown",true));
    await expect(setInitialMemberLimit({},form({memberId:"target",monthlyLimit:"25"}))).resolves.toEqual({error:"The initial limit outcome is unknown. Refresh membership before trying again."});
    expect(mocks.setInitialLimit).toHaveBeenCalledTimes(1);
    mocks.setInitialLimit.mockRejectedValueOnce(new KeeperUnavailableError("offline",false));
    await expect(setInitialMemberLimit({},form({memberId:"target",monthlyLimit:"25"}))).resolves.toEqual({error:"Initial limit setup is unavailable. Refresh the page before trying again."});
    expect(mocks.setInitialLimit).toHaveBeenCalledTimes(2);
  });
  it("rejects management calls from non-console members before any store mutation", async () => {
    mocks.owner.mockRejectedValue(new Error("refused"));
    const input = form({ memberId: "target", id: "invite", displayName: "Example", email: "member@example.test", role: "member" });
    for (const action of [() => createInvitation({}, input), () => revokeInvitation(input), () => removeMember(input), () => signOutMember(input)]) await expect(action()).rejects.toThrow("refused");
    for (const fn of [mocks.invite, mocks.revoke, mocks.remove, mocks.signOut]) expect(fn).not.toHaveBeenCalled();
  });
  it("can revoke invitations and forwards the opaque session for removal, but cannot remove the designated owner", async () => {
    await revokeInvitation(form({ id: "invite" })); expect(mocks.revoke).toHaveBeenCalledWith("owner", "invite");
    await removeMember(form({ memberId: "second", actorId: "forged-actor" }));
    expect(mocks.verify).toHaveBeenCalledWith(mocks.cookie);
    expect(mocks.keeper).toHaveBeenCalledWith("member.remove", {sessionToken:mocks.cookie,targetMemberId:"second"}, "owner@example.test");
    await expect(removeMember(form({ memberId: "owner" }))).rejects.toThrow("cannot be removed");
    expect(mocks.keeper).toHaveBeenCalledTimes(1);
  });
  it("refuses removal before Keeper when the verified audit address is unavailable",async()=>{
    mocks.verify.mockResolvedValue(null);
    await expect(removeMember(form({memberId:"second"}))).rejects.toThrow("Console sign-in expired");
    expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it("preserves unknown Keeper outcomes as refresh-before-retry guidance",async()=>{
    mocks.keeper.mockRejectedValue(new KeeperUnavailableError("uncertain",true));
    await expect(removeMember(form({memberId:"second"}))).rejects.toThrow("Member removal outcome is unknown. Refresh membership before trying again.");
  });
  it("self sign-out-all uses only the authenticated stable member, never caller fields", async () => {
    await expect(signOutEverywhere()).rejects.toThrow("redirect:/sign-in?signed-out=1");
    expect(mocks.signOut).toHaveBeenCalledWith("second", "second");
    expect(mocks.clear).toHaveBeenCalledWith("lares_session");
  });
});
