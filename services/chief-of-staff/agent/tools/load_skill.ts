/** Native instruction skills need no filesystem sandbox. Private sessions advertise none. */
import {defineDynamic,defineTool,defineDurableCallback,defineDurableSchema} from 'eve/tools';
import {z} from 'zod';
import {assertPrivateConsoleTool,verifyPrivateConsoleSession} from '@lares/agent-kit/private-console-surface';
import signals from '../skills/signals.js';
import salesOutreach from '../skills/sales-outreach.js';

const skills = {'signals':signals,'sales-outreach':salesOutreach};
export default defineDynamic({events:{'session.started':async(_event,ctx)=>{
  if(await verifyPrivateConsoleSession(ctx)) return null;
  return defineTool({
    description:'Load the full instructions for one available skill by name or id. Use this tool when the request clearly matches a listed skill description or when the user explicitly asks for that skill. Loading adds the skill instructions to the current turn. Choose the "skill" value from the Available skills block.',
    inputSchema:defineDurableSchema({closure:{},schema:()=>z.strictObject({skill:z.string().describe('Available skill name or id.')})}),
    execute:defineDurableCallback({closure:{},callback:async (_closure, {skill}: {skill:string},context)=>{
      assertPrivateConsoleTool(context,'chief-of-staff','load_skill');
      const resolver=skills[skill as keyof typeof skills];
      if(!resolver) throw new Error(`No skill named "${skill}". Available skills: ${Object.keys(skills).sort().join(', ')}.`);
      const resolved=await resolver.events['session.started']!({},context as never);
      if(!resolved) throw new Error(`No skill named "${skill}".`);
      return resolved.markdown;
    }}),
  });
}}});
