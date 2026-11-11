import {defineDynamic,defineInstructions} from 'eve/instructions';
import {loadDefinition} from '@lares/agent-kit/definition';
// Read ONCE PER CONVERSATION: eve 1.0 runs this before every model call, and the memo keyed on the
// session keeps the first read, so edited duties reach the next conversation, never a running one.
export default defineDynamic(async ctx=>defineInstructions({content:await ctx.memo(['duties',ctx.session.id],async()=>(await loadDefinition({serviceDir:'unused'})).dutiesMd)}));
