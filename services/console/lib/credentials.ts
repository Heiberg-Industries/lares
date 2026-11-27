import { CREDENTIAL_SLOT, credentialStatusSchema, type CredentialStatus } from '@lares/agent-kit/credential-lifecycle';
import { actingAddress } from './auth';
import { keeper, KeeperRefusedError } from './keeper-client';

export type CredentialView = { kind: 'status'; status: CredentialStatus } |
  { kind: 'unavailable' | 'administrator-required' | 'sign-in-required' };
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
  // An admin may open Integrations and sees the state; the keeper answers its administrator only,
  // so for anyone else this comes back as 'administrator-required' and the key cannot be changed.
  const actor = await actingAddress("admin");
  return actor ? credentialViewFor(actor) : { kind: 'sign-in-required' };
}
