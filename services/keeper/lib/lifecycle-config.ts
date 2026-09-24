import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { DIGEST } from './compose-agents.js';
import { runtimeBindingsSchema } from './runtime-bindings.js';
const path = z.string().refine(isAbsolute), image = z.string().regex(DIGEST);
const role = z.enum(['chief-of-staff', 'travel', 'creative']);
const db = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), database: z.string().min(1), user: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), passwordFile: path }).strict();
const defaultBindings = z.partialRecord(role, runtimeBindingsSchema).superRefine((bindings, ctx) => {
    for (const [key, binding] of Object.entries(bindings))
        if (binding && binding.role !== key)
            ctx.addIssue({ code: 'custom', path: [key], message: 'Default runtime binding role mismatch' });
});
/** This is installation configuration, NOT parameters accepted from actions. Required lists
 * are explicit even when empty: no omitted options silently remove an existing seal. */
export const lifecycleSchema = z.object({
    network: z.string().min(1), subnet: z.string().min(1), reservedAddresses: z.array(z.string()),
    composeFile: path, egressDir: path, imageByRole: z.object({ 'chief-of-staff': image, travel: image, creative: image }).strict(),
    proxyContainer: z.string().regex(/^lares-[a-z0-9_-]+$/), squidImage: image, firewallImage: image,
    adminDb: db, workflowTemplate: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), workflowOwner: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    // Installation-only master switch: definitions cannot turn schedules on by themselves.
    runtime: z.object({ schedulesLive: z.boolean().default(false), databaseUrl: z.string().url(), workflowServer: z.string().url(), gatewayUrl: z.string().url(), proxyUrl: z.string().url(), passwordFile: path,
        // Exact entries retain existing/external-gateway installations. A fresh on-box
        // installation instead supplies its admin key and lets the keeper mint one stable,
        // budgeted virtual key per agent under its managed secrets root.
        gatewayKeys: z.record(z.string(), path), gatewayMasterKeyFile: path.optional(),
        google: z.object({principal:z.string().min(1),tokenKeyFile:path,clients:z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/),z.object({clientIdFile:path,clientSecretFile:path}).strict())}).strict().optional() }).strict(),
    egress: z.object({ endpoints: z.object({ READABILITY_URL: z.string().url().optional(), ORAKEL_URL: z.string().url().optional(), TWENTY_BASE_URL: z.string().url().optional() }).strict(), legacyConsumers: z.array(z.object({ name: z.string(), address: z.string(), hosts: z.array(z.string()) }).strict()), internalNetworks: z.array(z.string()), directDestinations: z.array(z.string()), infrastructureHosts: z.array(z.string()) }).strict(),
    // Owner verifies a DIRECTORY-mounted owned proxy and complete retained-source inventory in Task20.
    installationPrepared: z.literal(true),
    bindings: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,30}$/), runtimeBindingsSchema).optional(),
    // Fresh installs do not know the first agent's name yet. An exact name binding wins;
    // otherwise the role default supplies installation-owned identity and secret sources.
    defaultBindings: defaultBindings.optional(),
}).strict();
export type LifecycleConfig = z.infer<typeof lifecycleSchema>;
