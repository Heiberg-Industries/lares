/** Native instruction skills need no filesystem sandbox. Private sessions advertise none. */
import {defineDynamic,defineTool,defineDurableCallback,defineDurableSchema} from 'eve/tools';
import {z} from 'zod';
import {assertPrivateConsoleTool,isPrivateConsoleContext,verifyPrivateConsoleSession} from '@lares/agent-kit/private-console-surface';
import signals from '../skills/signals.js';
import salesOutreach from '../skills/sales-outreach.js';
import laresDocs from '../skills/lares-docs.js';

const skills = {'signals':signals,'sales-outreach':salesOutreach,'lares-docs':laresDocs};
export default defineDynamic({events:{'session.started':async(_event,ctx)=>{
  const privateSession=await verifyPrivateConsoleSession(ctx);
  const availableSkills=privateSession?['lares-docs']:Object.keys(skills).sort();
  return defineTool({
    description:`Load the full instructions for one available skill by name or id. Use this tool when the request clearly matches a listed skill description or when the user explicitly asks for that skill. Loading adds the skill instructions to the current turn. Available skills: ${availableSkills.join(', ')}.`,
    inputSchema:defineDurableSchema({closure:{privateSession},schema:(closure:{privateSession:boolean})=>z.strictObject({skill:closure.privateSession?z.literal('lares-docs'):z.string().describe('Available skill name or id.')})}),
    execute:defineDurableCallback({closure:{},callback:async (_closure, {skill}: {skill:string},context)=>{
      const privateSession=await verifyPrivateConsoleSession(context);
      if(privateSession&&skill!=='lares-docs')throw new Error('No skill named "lares-docs".');
      if(!privateSession&&skill==='lares-docs'&&isPrivateConsoleContext(context))throw new Error('Conversation authority is unavailable');
      if(!privateSession)assertPrivateConsoleTool(context,'chief-of-staff','load_skill');
      const resolver=skills[skill as keyof typeof skills];
      if(!resolver) throw new Error(`No skill named "${skill}". Available skills: ${Object.keys(skills).sort().join(', ')}.`);
      const resolved=await resolver.events['session.started']!({},context as never);
      if(!resolved) throw new Error(`No skill named "${skill}".`);
      return resolved.markdown;
    }}),
  });
}}});
