import { cookies } from 'next/headers';
import { CREDENTIAL_SLOT, credentialStatusSchema, type CredentialStatus } from '@lares/agent-kit/credential-lifecycle';
import { verify } from './auth';
import { keeper, KeeperRefusedError } from './keeper-client';

export type CredentialView = { kind: 'status'; status: CredentialStatus } |
  { kind: 'unavailable' | 'administrator-required' | 'sign-in-required' };
export async function credentialActor(): Promise<string | null> {
  try { return await verify((await cookies()).get('lares_session')?.value); } catch { return null; }
}
/** Keeper's explicit root-configured administrator is the sole authority. No provider read. */
export async function credentialViewFor(actor: string): Promise<CredentialView> {
  try {
    const status = credentialStatusSchema.parse(await keeper('credential.status', { slot: CREDENTIAL_SLOT }, actor));
    return { kind: 'status', status };
  } catch (error) {
    return { kind: error instanceof KeeperRefusedError ? 'administrator-required' : 'unavailable' };
  }
}
export async function getCredentialView(): Promise<CredentialView> {
  const actor = await credentialActor();
  return actor ? credentialViewFor(actor) : { kind: 'sign-in-required' };
}
