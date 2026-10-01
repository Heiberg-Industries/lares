// LAR-105: an agent with nothing safe to run on must not look healthy.
//
// Each role's instrumentation awaits this AT MODULE LEVEL, after the LAR-73 lock release: the
// built server evaluates that module to the end before it opens its HTTP port, so a refusal here
// happens before `/eve/v1/health` can ever answer. The container then restarts and refuses
// again, and the keeper's health wait reports "did not become healthy" instead of "done".
//
// Before this, the boot read was a fire-and-forget promise whose rejection became a log line —
// the agent kept answering its health address and failed every conversation, because each one
// re-resolves the same unusable definition (definition-cache.ts throws "no last valid one to fall
// back to"). That module always meant this case to be a visible restart loop; the catch in
// instrumentation silently overrode it.
//
// WHAT STAYS "NEVER A DEAD AGENT": everything after a definition is in hand. Registering with the
// console's agent list is still a log line on failure. Only "no definition at all" stops the
// process — and so does a database that cannot be read at boot, because every conversation would
// fail on the same read.
//
// 78 is EX_CONFIG, as in images/agent-runtime/start.sh: "this installation is configured
// wrongly", not "the agent crashed".
export const UNUSABLE_DEFINITION_EXIT = 78;

export async function bootDefinitionOrStop<T>(
  resolve: () => Promise<T>,
  stop: (code: number) => never = (code) => process.exit(code),
): Promise<T> {
  try {
    return await resolve();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[definition] this agent has no usable definition, so it is not starting: ${reason}`);
    return stop(UNUSABLE_DEFINITION_EXIT);
  }
}
