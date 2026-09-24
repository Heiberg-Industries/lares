import { afterEach, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllEnvs());
it("imports without owner configuration, rejects missing identity and reads later settings", async () => {
  vi.stubEnv('AGENT_OWNER_USER_ID', '');
  vi.resetModules();
  const { configuredOwnerId } = await import('../lib/identity-client.js');
  expect(() => configuredOwnerId()).toThrow('Owner identity is not configured');
  vi.stubEnv('AGENT_OWNER_USER_ID', ' first-owner ');
  expect(configuredOwnerId()).toBe('first-owner');
  vi.stubEnv('AGENT_OWNER_USER_ID', 'second-owner');
  expect(configuredOwnerId()).toBe('second-owner');
});
it("missing ownership cannot reach the ungated send fallback or pass a precheck", async () => {
  vi.stubEnv('AGENT_OWNER_USER_ID', '');
  const { initiate, wouldInitiate } = await import('../lib/initiation.js');
  const send = vi.fn(async () => {});
  const request = { cls: 'scheduled' as const, door: 'telegram:fixture', itemKey: 'fixture/test' };
  await expect(initiate('fixture', request, send)).rejects.toThrow('Owner identity is not configured');
  await expect(wouldInitiate('fixture', request)).rejects.toThrow('Owner identity is not configured');
  expect(send).not.toHaveBeenCalled();
});
