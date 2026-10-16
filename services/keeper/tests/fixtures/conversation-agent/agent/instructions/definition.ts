import {defineDynamic,defineInstructions} from 'eve/instructions';
import {loadDefinition} from '@lares/agent-kit/definition';
export default defineDynamic({events:{'session.started':async()=>defineInstructions({markdown:(await loadDefinition({serviceDir:'unused'})).dutiesMd})}});
