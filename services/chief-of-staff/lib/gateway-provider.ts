/**
 * Constructs @lares/agent-kit's gateway provider with chief-of-staff's own default gateway-key
 * file path. See there for the shared mechanism (LiteLLM gateway routing, Accept-Encoding:
 * identity, lazy/no-build-time secret reads).
 *
 * The chief of staff's own key (`/run/secrets/gateway-key`), never shared with another agent's.
 * Overridable at runtime via GATEWAY_KEY_FILE regardless.
 */
import { createGatewayProvider, IDENTITY_ENCODING_HEADERS } from "@lares/agent-kit/gateway-provider";

const provider = createGatewayProvider({ defaultKeyFile: "/run/secrets/gateway-key" });

export const gatewayModel = provider.gatewayModel;
export const gatewayUrl = provider.gatewayUrl;
export const gatewayKey = provider.gatewayKey;
export { IDENTITY_ENCODING_HEADERS };
