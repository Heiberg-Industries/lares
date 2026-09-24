/**
 * Constructs @lares/agent-kit's gateway provider with eve-marcel's own default gateway-key
 * file path. See there for the shared mechanism (LiteLLM gateway routing, Accept-Encoding:
 * identity, lazy/no-build-time secret reads).
 *
 * Marcel's OWN key (`marcel-eve-gateway-key`: budget-capped + model-allowlisted per
 * ORB-77), never shared with eve-saga's `gateway-key`. Overridable at runtime via
 * GATEWAY_KEY_FILE regardless.
 */
import { createGatewayProvider, IDENTITY_ENCODING_HEADERS } from "@lares/agent-kit/gateway-provider";

const provider = createGatewayProvider({
  defaultKeyFile: "/run/secrets/marcel-eve-gateway-key",
});

export const gatewayModel = provider.gatewayModel;
export const gatewayUrl = provider.gatewayUrl;
export const gatewayKey = provider.gatewayKey;
export { IDENTITY_ENCODING_HEADERS };
