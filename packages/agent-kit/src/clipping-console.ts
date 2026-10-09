import { z } from 'zod';

/**
 * What the console's Clipping card sends (`POST /api/clipping`) and the shapes of the answers the
 * chief of staff writes into `clipping_requests.result` (box/sql/092). Kept here, beside
 * credential-lifecycle.ts, because the console has no direct zod dependency and these are the
 * only shapes it must not trust. The ENGINE side (services/chief-of-staff/lib/clipping/requests.ts)
 * does not import this file: the result shapes are mirrored by hand and pinned by the console's
 * tests, the same two-place truth the rest of the console keeps.
 */
export const CLIPPING_MODES = ['notion', 'karakeep', 'both'] as const;
export type ClippingMode = (typeof CLIPPING_MODES)[number];

const id = z.string().min(1).max(200);
const optionalColumn = id.nullable().optional();

export const clippingActionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read-database'), link: z.string().trim().min(1).max(2048) }).strict(),
  z.object({
    action: z.literal('save-mapping'), dataSourceId: id, urlPropertyId: id,
    notePropertyId: optionalColumn, tagsPropertyId: optionalColumn, savedPropertyId: optionalColumn,
  }).strict(),
  z.object({ action: z.literal('test') }).strict(),
  z.object({ action: z.literal('import') }).strict(),
  z.object({ action: z.literal('add-properties') }).strict(),
  z.object({ action: z.literal('set-choice'), mode: z.enum(CLIPPING_MODES) }).strict(),
  z.object({ action: z.literal('preview-grant') }).strict(),
]);
export type ClippingActionInput = z.infer<typeof clippingActionInput>;

const count = z.number().int().min(0).max(1_000_000);
const column = z.object({ id, name: z.string().max(500), type: z.string().max(100) });

export const clippingSchemaResult = z.object({
  databaseId: z.string().max(100),
  dataSources: z.array(z.object({ id, name: z.string().max(500), columns: z.array(column).max(500) })).max(10),
  suggested: z.object({ titleId: id.nullable(), urlId: id.nullable() }),
});
export type ClippingSchemaResult = z.infer<typeof clippingSchemaResult>;

export const clippingTestResult = z.object({
  wouldImport: count, fromUrlColumn: count, fromTitle: count, withoutLink: count, alreadyImported: count,
  more: z.boolean(), warnings: z.array(z.string().max(500)).max(10).optional(),
});
export type ClippingTestResult = z.infer<typeof clippingTestResult>;

export const clippingImportResult = z.object({
  imported: count, updated: count.optional(), trashed: count.optional(), skipped: count.optional(),
  noLink: count.optional(), duplicates: count.optional(), editedAfterFiling: count.optional(),
});
export type ClippingImportResult = z.infer<typeof clippingImportResult>;

export const clippingAddPropertiesResult = z.object({
  added: z.array(z.string().max(100)).max(10),
  present: z.array(z.string().max(100)).max(10),
  conflicts: z.array(z.object({ name: z.string().max(100), found: z.string().max(100), wanted: z.string().max(100) })).max(10),
});
export type ClippingAddPropertiesResult = z.infer<typeof clippingAddPropertiesResult>;
