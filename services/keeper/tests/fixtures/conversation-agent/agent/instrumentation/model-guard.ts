// The model guard, first statement: the same call the role services make first in their
// instrumentation. This fixture's model is a mock, but
// eve keeps only a model's id between steps and, picking a conversation up cold, resolves that id
// again through the AI SDK's default provider, which reaches a hosted gateway. This makes that
// default refuse every request, process-wide and locked. eve 1.0 reads instrumentation from this
// directory, one file per provider.
import {installRefusingDefaultProvider} from '@lares/agent-kit/gateway-budget';
import {defineInstrumentation} from 'eve/instrumentation';

installRefusingDefaultProvider();

export default defineInstrumentation({});
