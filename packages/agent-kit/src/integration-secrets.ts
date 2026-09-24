// GENERATED FILE — do not edit by hand.
// Regenerate with: pnpm -C packages/agent-kit run generate:connections
//
// Source: the `secretEnv` entries in `integrations/installation.json` (the same file the
// console's `connections.ts` is generated from — LAR-76 made the two lists ONE truth).
// `packages/agent-kit/tests/integration-generate.test.ts` fails when this file is stale.
//
// WHAT THIS DECIDES. The keeper merges this map with its own small, hand-written list of
// PLATFORM secrets (a route password, the token-at-rest key, the tracing keys — none of them
// an integration) and mounts nothing outside the union. Adding a line here widens what an
// agent definition can ask for, so a line is added by editing the installation file and
// regenerating, never by hand.
//
// KEY = the environment variable the runtime reads the mounted path from; the binding in an
// agent definition is keyed by it. VALUE = the secret's file name, which is both what it is
// called on the box and what it is called at /run/secrets/<name> inside the container.
//
// LAR-76 renamed two VALUES: the Google client pair was spelled `travel-google-client-id` /
// `travel-google-client-secret` here, a spelling that exists on no box and in no other file.
// Both readers of those variables already fall back to the names below, which are also the
// ones the installation file and the box itself use.

/** Environment variable → secret file name, for every integration credential an agent
 *  definition may ask the keeper to mount. */
export const INTEGRATION_SECRET_FILES = {
  GOOGLE_CLIENT_ID_HEIBERG_FILE: "google-client-id-heiberg",   // google:heiberg
  GOOGLE_CLIENT_SECRET_HEIBERG_FILE: "google-client-secret-heiberg",   // google:heiberg
  TWENTY_KEY_FILE: "twenty-key",   // twenty:shared
  ORAKEL_KEY_FILE: "orakel-key",   // orakel:shared
  READABILITY_TOKEN_FILE: "readability-token",   // readability:shared
  NOTION_TOKEN_FILE: "notion-token",   // notion:shared
  KARAKEEP_API_KEY_FILE: "karakeep-api-key",   // karakeep:shared
  SIGNAL_SPINE_TOKEN_FILE: "signal-spine-token",   // signals:shared
  GOOGLE_PLACES_API_KEY_FILE: "google-places-api-key",   // places:shared
  AERODATABOX_API_KEY_FILE: "aerodatabox-api-key",   // aerodatabox:shared
  MARCEL_STRAVA_CLIENT_ID_FILE: "strava-client-id",   // strava:shared
  MARCEL_STRAVA_CLIENT_SECRET_FILE: "strava-client-secret",   // strava:shared
} as const;
