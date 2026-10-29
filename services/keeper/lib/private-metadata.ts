import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { KeeperRefusedError, registerAction } from './actions.js';
import type { OutsideCustodyStore } from './outside-custody.js';

const bearer = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const scope = z.enum(['upload', 'read']);

/** The server-facing identity returned only after the scoped token is checked against current
 * member, account and device generations. Callers never choose any identity field. */
export interface PrivateMetadataCredentialIdentity {
  datasetId: string;
  accountId: string;
  ownerMemberId: string;
  scope: 'upload' | 'read';
  generation: number;
}

export function privateMetadataTokenHash(token: string): Buffer {
  if (!bearer.safeParse(token).success) throw new Error('Invalid private metadata credential');
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Register the narrow HTTPS relay action. The relay passes only the bearer and requested
 * scope; Keeper returns server-derived dataset identity or a fixed refusal. */
export function registerPrivateMetadataActions(store: OutsideCustodyStore): void {
  registerAction({
    name: 'private-metadata.credential.validate',
    input: z.strictObject({ token: bearer, scope }),
    secretFields: ['token'],
    run: async input => {
      try { return await store.validatePrivateMetadataCredential(input.token, input.scope); }
      catch (error) {
        if (error instanceof KeeperRefusedError) throw error;
        if (error instanceof Error && error.message === 'Private metadata credential refused')
          throw new KeeperRefusedError('Private metadata credential refused');
        throw error;
      }
    },
  });
}

/** Opaque, upload-only token minted for the authenticated member's explicit device consent. */
export function mintPrivateMetadataUploadToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newPrivateMetadataDeviceId(): string {
  return randomUUID();
}
