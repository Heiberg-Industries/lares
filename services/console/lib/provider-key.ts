import { keeper } from './keeper-client';
import { providerKeyStatusSchema, type ProviderKeyView } from './provider-key-schema';

/** The keeper checks the session and the designated owner itself; this only asks it. */
export async function providerKeyStatusFor(sessionToken: string, name: string, actor: string): Promise<ProviderKeyView> {
  try {
    return { kind: 'status', status: providerKeyStatusSchema.parse(await keeper('provider-key.status', { sessionToken, name }, actor)) };
  } catch { return { kind: 'unavailable' }; }
}
