/**
 * Idempotently create the network-layer custom fields in Twenty,
 * via the Metadata API, on the Person object:
 *
 *   pulse              (SELECT)    — cross-channel personal-relationship band
 *   lastPersonalContact (DATE_TIME) — most recent personal-channel interaction
 *
 * The SELECT option `value`s are the exact PulseLevel strings the sync writes
 * back — keep them in sync with lib/pulse.ts.
 *
 * Run (from services/network/):
 *   pnpm provision:fields
 *
 * Reads config from ~/.lares/config.json and the macOS Keychain.
 * Touches metadata only — never data records. Safe to re-run.
 */

import { loadConfig, resolveTwentyApiKey } from "../lib/config.js";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Config / auth — local-first, keychain-backed (not env-var based)
// ---------------------------------------------------------------------------

const config = loadConfig();

if (!config.twentyBaseUrl) {
  console.error(
    "Error: twentyBaseUrl is not set in ~/.lares/config.json.\n" +
      "Add it with:\n" +
      '  { "twentyBaseUrl": "https://crm.owner.example" }',
  );
  process.exit(1);
}

const baseUrl: string = config.twentyBaseUrl;
let apiKey: string;
try {
  apiKey = resolveTwentyApiKey(config);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Metadata API helper
// ---------------------------------------------------------------------------

async function metadata(
  method: Method,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${baseUrl}/rest/metadata${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

const PULSE_OPTIONS = [
  { value: "NO_CONNECTION", label: "No connection", color: "gray", position: 0 },
  { value: "VERY_WEAK", label: "Very weak", color: "red", position: 1 },
  { value: "WEAK", label: "Weak", color: "orange", position: 2 },
  { value: "GOOD", label: "Good", color: "yellow", position: 3 },
  { value: "STRONG", label: "Strong", color: "green", position: 4 },
  { value: "VERY_STRONG", label: "Very strong", color: "turquoise", position: 5 },
] as const;

type PulseOption = (typeof PULSE_OPTIONS)[number];

type PlannedField =
  | {
      apiName: string;
      label: string;
      type: "DATE_TIME";
      description: string;
    }
  | {
      apiName: string;
      label: string;
      type: "SELECT";
      options: readonly PulseOption[];
      description: string;
    };

const FIELDS: PlannedField[] = [
  {
    apiName: "pulse",
    label: "Pulse",
    type: "SELECT",
    options: PULSE_OPTIONS,
    description:
      "Cross-channel personal-relationship band (LinkedIn + iMessage + calls), written by the local network layer",
  },
  {
    apiName: "lastPersonalContact",
    label: "Last personal contact",
    type: "DATE_TIME",
    description: "Most recent personal-channel interaction (network layer)",
  },
];

// ---------------------------------------------------------------------------
// Object discovery
// ---------------------------------------------------------------------------

interface ObjectMetadataNode {
  id: string;
  nameSingular: string;
  fields?: { name: string }[];
}

async function getObjects(): Promise<Map<string, { id: string; fields: Set<string> }>> {
  const res = await metadata("GET", "/objects?limit=200");
  if (!res.ok) {
    throw new Error(
      `Failed to list metadata objects (HTTP ${res.status}): ${JSON.stringify(res.data)}`,
    );
  }
  const nodes = (res.data as { data?: ObjectMetadataNode[] })?.data ?? [];
  const map = new Map<string, { id: string; fields: Set<string> }>();
  for (const n of nodes) {
    map.set(n.nameSingular, {
      id: n.id,
      fields: new Set((n.fields ?? []).map((f) => f.name)),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Field creation
// ---------------------------------------------------------------------------

async function createField(
  field: PlannedField,
  objectMetadataId: string,
  existing: Set<string>,
): Promise<"created" | "skipped" | "conflict"> {
  if (existing.has(field.apiName)) return "skipped";

  const body: Record<string, unknown> = {
    name: field.apiName,
    label: field.label,
    type: field.type,
    objectMetadataId,
    description: field.description,
    isNullable: true,
  };
  if (field.type === "SELECT") body.options = field.options;

  const res = await metadata("POST", "/fields", body);
  if (res.ok) return "created";

  const dataStr = JSON.stringify(res.data ?? "").toLowerCase();
  if (
    res.status === 409 ||
    dataStr.includes("already exists") ||
    dataStr.includes("duplicate")
  ) {
    return "conflict";
  }
  throw new Error(
    `Failed to create ${field.apiName} (HTTP ${res.status}): ${JSON.stringify(res.data)}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const objects = await getObjects();
  const obj = objects.get("person");

  if (!obj) {
    console.error(
      `  ✗ object "person" not found (available: ${[...objects.keys()].join(", ")})`,
    );
    process.exit(1);
  }

  console.log(`\nperson (${obj.id}):`);
  for (const field of FIELDS) {
    try {
      const result = await createField(field, obj.id, obj.fields);
      const icon = result === "created" ? "✓ created" : `– skipped (${result})`;
      console.log(`  ${icon}: ${field.apiName} (${field.type})`);
    } catch (err) {
      console.error(`  ✗ ${field.apiName}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", (err as Error).message);
  process.exit(1);
});
