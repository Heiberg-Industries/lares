// The model guard, and nothing else. FIRST statement, exactly as in the role services
// (services/*/agent/instrumentation/): this fixture's model is a scripted mock, but eve keeps only
// a model's id between steps and, picking a conversation up cold (a restart, a between-turns
// compact), resolves that id again through the AI SDK's DEFAULT provider, which reaches a hosted
// model gateway. This replaces that default, process-wide and locked, with one that refuses every
// request, so no eval, proof or probe built from this fixture can reach a model provider.
//
// eve 1.0 reads instrumentation from this DIRECTORY, one file per provider (a single
// `agent/instrumentation.ts` fails the build), and compiles it into its own bundle
// (lib/file-board.ts explains what that costs a shared module). The guard is a locked property on
// `globalThis`, so the bundle boundary does not matter. The built server loads instrumentation
// before it opens its HTTP port.
//
// No handlers and no `setup`: nothing here exports or reads traces.
import { installRefusingDefaultProvider } from "@lares/agent-kit/gateway-budget";
import { defineInstrumentation } from "eve/instrumentation";

installRefusingDefaultProvider();

export default defineInstrumentation({});
