import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { DIGEST } from './compose-agents.js';
import { runtimeBindingsSchema, isRetiredRole } from './runtime-bindings.js';
const path = z.string().refine(isAbsolute), image = z.string().regex(DIGEST);
const SUPPORTED_ENDPOINTS = new Set(['READABILITY_URL', 'TWENTY_BASE_URL']);
/** An older keeper.json may still name an endpoint this engine no longer supports. Dropping it
 * (with a log line) keeps that file loading; it never reaches the egress or compose output. */
function ignoreRetiredEndpoints(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const kept: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (SUPPORTED_ENDPOINTS.has(key)) kept[key] = entry;
        else console.warn(`keeper: ignoring unsupported egress endpoint "${key}" in the config`);
    }
    return kept;
}
const role = z.enum(['chief-of-staff', 'creative']);
/** An older keeper.json may still carry the removed role in `imageByRole`, `defaultBindings` or a
 * named binding. Drop it (with a log line) so the file keeps loading; nothing in it reaches the output. */
function dropRetiredRoleEntries(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const kept: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (isRetiredRole(key)) console.warn(`keeper: ignoring the "${key}" role entry in the config; that role is no longer part of the engine`);
        else kept[key] = entry;
    }
    return kept;
}
function dropRetiredRoleBindings(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const kept: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'object' && entry !== null && isRetiredRole((entry as { role?: unknown }).role))
            console.warn(`keeper: ignoring the runtime binding for "${key}" in the config; its role is no longer part of the engine`);
        else kept[key] = entry;
    }
    return kept;
}
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
    composeFile: path, egressDir: path, imageByRole: z.preprocess(dropRetiredRoleEntries, z.object({ 'chief-of-staff': image, creative: image }).strict()),
    proxyContainer: z.string().regex(/^lares-[a-z0-9_-]+$/), squidImage: image, firewallImage: image,
    adminDb: db, workflowTemplate: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), workflowOwner: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    // Installation-only master switch: definitions cannot turn schedules on by themselves.
    runtime: z.object({ schedulesLive: z.boolean().default(false), databaseUrl: z.string().url(), workflowServer: z.string().url(), gatewayUrl: z.string().url(), proxyUrl: z.string().url(), passwordFile: path,
        // Exact entries retain existing/external-gateway installations. A fresh on-box
        // installation instead supplies its admin key and lets the keeper mint one stable,
        // budgeted virtual key per agent under its managed secrets root.
        gatewayKeys: z.record(z.string(), path), gatewayMasterKeyFile: path.optional(),
        google: z.object({principal:z.string().min(1),tokenKeyFile:path,clients:z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/),z.object({clientIdFile:path,clientSecretFile:path}).strict())}).strict().optional() }).strict(),
    egress: z.object({ endpoints: z.preprocess(ignoreRetiredEndpoints, z.object({ READABILITY_URL: z.string().url().optional(), TWENTY_BASE_URL: z.string().url().optional() }).strict()), legacyConsumers: z.array(z.object({ name: z.string(), address: z.string(), hosts: z.array(z.string()) }).strict()), internalNetworks: z.array(z.string()), directDestinations: z.array(z.string()), infrastructureHosts: z.array(z.string()) }).strict(),
    // Owner verifies a DIRECTORY-mounted owned proxy and complete retained-source inventory.
    installationPrepared: z.literal(true),
    bindings: z.preprocess(dropRetiredRoleBindings, z.record(z.string().regex(/^[a-z][a-z0-9-]{1,30}$/), runtimeBindingsSchema)).optional(),
    // Fresh installs do not know the first agent's name yet. An exact name binding wins;
    // otherwise the role default supplies installation-owned identity and secret sources.
    defaultBindings: z.preprocess(dropRetiredRoleEntries, defaultBindings).optional(),
}).strict();
export type LifecycleConfig = z.infer<typeof lifecycleSchema>;
