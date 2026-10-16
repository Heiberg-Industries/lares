/**
 * Constructs @lares/agent-kit's gateway provider with creative agent's own default gateway-key
 * file path. See there for the shared mechanism (LiteLLM gateway routing, Accept-Encoding:
 * identity, lazy/no-build-time secret reads).
 *
 * The creative agent uses the SHARED `/run/secrets/gateway-key`, the same file chief-of-staff reads — not a
 * key of her own the way the travel agent has `the travel agent-eve-gateway-key`. That is deliberate for the
 * port: old the creative agent ran on the agent-runtime image with the fleet's shared gateway key, and
 * giving her a budget-capped key of her own (the shape) is a separate decision with a
 * LiteLLM-side change behind it, not something to smuggle in with a framework move.
 * Overridable at runtime via GATEWAY_KEY_FILE regardless.
 */
import { createGatewayProvider, IDENTITY_ENCODING_HEADERS } from "@lares/agent-kit/gateway-provider";

const provider = createGatewayProvider({ defaultKeyFile: "/run/secrets/gateway-key" });

export const gatewayModel = provider.gatewayModel;
export const gatewayUrl = provider.gatewayUrl;
export const gatewayKey = provider.gatewayKey;
export { IDENTITY_ENCODING_HEADERS };
