/**
 * Constructs @lares/agent-kit's gateway provider with eve-calliope's own default gateway-key
 * file path. See there for the shared mechanism (LiteLLM gateway routing, Accept-Encoding:
 * identity, lazy/no-build-time secret reads).
 *
 * Calliope uses the SHARED `/run/secrets/gateway-key`, the same file eve-saga reads — not a
 * key of her own the way Marcel has `marcel-eve-gateway-key`. That is deliberate for the
 * port: old Calliope ran on the agent-runtime image with the fleet's shared gateway key, and
 * giving her a budget-capped key of her own (the ORB-77 shape) is a separate decision with a
 * LiteLLM-side change behind it, not something to smuggle in with a framework move.
 * Overridable at runtime via GATEWAY_KEY_FILE regardless.
 */
import { createGatewayProvider, IDENTITY_ENCODING_HEADERS } from "@lares/agent-kit/gateway-provider";

const provider = createGatewayProvider({ defaultKeyFile: "/run/secrets/gateway-key" });

export const gatewayModel = provider.gatewayModel;
export const gatewayUrl = provider.gatewayUrl;
export const gatewayKey = provider.gatewayKey;
export { IDENTITY_ENCODING_HEADERS };
