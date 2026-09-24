import {expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {DefinitionForm} from '../components/DefinitionForm';
import {CeilingNotice} from '../components/CeilingNotice';
import {startingPoints,modelAliases,takesEffect} from '../lib/builder';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../app/actions/definition',()=>({createAgent:vi.fn(),saveDefinition:vi.fn(),retireAgent:vi.fn(),deleteAgent:vi.fn(),applyConnections:vi.fn(),listConversations:vi.fn(),startFreshConversation:vi.fn()}));
vi.mock('../app/actions/autonomy',()=>({setAutonomy:vi.fn()}));
const base={startingPoints:startingPoints(),aliases:modelAliases('example'),timing:Object.fromEntries(['name','gender','description','startingPoint','duties','voice','language','model','grants','skills','autonomy','schedules','doors'].map(f=>[f,takesEffect(f)])),capacity:{ceiling:6,activeCount:3,approved:true,creationAvailable:true}};
it('keeps new-agent permission writes unavailable and gives every field its timing',()=>{
 const html=renderToStaticMarkup(<DefinitionForm {...base}/>);
 expect(html).toContain('Create this agent first');expect(html).not.toContain('title="Always allow"');
 expect(html).toContain('What is this agent for? Write it the way you would tell a person.');
 expect(html).toContain('This box holds 6 agents. You have 3.');
 expect(html).toContain('Takes effect at its next action.');expect(html).toContain('Takes effect the next time it runs.');
 expect(html).not.toContain('installation-brain');
});
it('prefills edit data, shows pending restart, and renders permission buttons as non-submit',()=>{
 const definition={...base.startingPoints[0].definition,name:'example',model:'example-brain'};
 const html=renderToStaticMarkup(<DefinitionForm {...base} initial={{definition,duties:'Unique duties',voice:'Unique voice',hash:'a'.repeat(64),runtime:{pending:true,reason:'Changed doors'},status:'valid'}} permissions={[{agent:'example',displayName:'Example',capability:'twenty',action:'',actionLabel:null,scope:'write-with-confirm',level:'gated',source:{kind:'definition'},controllable:true,lockedTools:[{tool:'delete',reason:'Always asks'}],evidence:{asked:0,autonomous:0,denied:0,locked:0,failedClosed:0,lastAt:null},answers:{approved:0,cancelled:0,neverAnswered:0,rate:null},couldGraduate:false}]}/>);
 expect(html).toContain('Unique duties');expect(html).toContain('Unique voice');expect(html).not.toContain('name="startingPoint"');
 expect(html).toContain('Apply connection changes (restarts agent)');expect(html).toContain('type="button" title="Always allow"');expect(html).toContain('Always asks');expect(html).toContain('Start a fresh conversation now');
});
it('distinguishes unapproved capacity and a full box',()=>{
 expect(renderToStaticMarkup(<CeilingNotice capacity={{ceiling:null,activeCount:3,approved:false,creationAvailable:false}}/>)).toContain('not been measured and approved');
 expect(renderToStaticMarkup(<CeilingNotice capacity={{ceiling:0,activeCount:0,approved:true,creationAvailable:false}}/>)).toContain('retire one or move to a larger server');
});
