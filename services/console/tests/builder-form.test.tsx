// @vitest-environment jsdom
import React from 'react';
import {expect,it,vi,afterEach} from 'vitest';
import {render,cleanup,fireEvent,waitFor} from '@testing-library/react';
import {applyConnections} from '../app/actions/definition';
afterEach(cleanup);
import {renderToStaticMarkup} from 'react-dom/server';
import {DefinitionForm} from '../components/DefinitionForm';
import {CeilingNotice} from '../components/CeilingNotice';
import {startingPoints,modelAliases,takesEffect} from '../lib/builder';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../app/actions/definition',()=>({createAgent:vi.fn(),saveDefinition:vi.fn(),retireAgent:vi.fn(),deleteAgent:vi.fn(),applyConnections:vi.fn(),listConversations:vi.fn(),startFreshConversation:vi.fn()}));
vi.mock('../app/actions/autonomy',()=>({setAutonomy:vi.fn()}));
const base={startingPoints:startingPoints(),aliases:modelAliases('example'),timing:Object.fromEntries(['name','gender','description','startingPoint','duties','voice','language','model','grants','skills','autonomy','schedules','doors'].map(f=>[f,takesEffect(f)])),capacity:{ceiling:6,activeCount:3,approved:true,creationAvailable:true,canChange:true}};
it('keeps new-agent permission writes unavailable and gives every field its timing',()=>{
 render(<DefinitionForm {...base}/>);
 const html=document.body.innerHTML;
 expect(html).toContain('Create this agent first');expect(html).not.toContain('role="group" aria-label=');
 expect(html).toContain('What is this agent for? Write it the way you would tell a person.');
 expect(html).toContain('This box holds up to 6 agents. You have 3.');expect(html).toContain('Change it in Settings');
 expect(html).toContain('Access and skills');expect(html).toContain('Schedules');
 expect(html).not.toContain('installation-brain');
});
it('prefills edit data, shows pending restart, and renders permission buttons as non-submit',()=>{
 const definition={...base.startingPoints[0].definition,name:'example',model:'example-brain'};
 const html=renderToStaticMarkup(<DefinitionForm {...base} initial={{definition,duties:'Unique duties',voice:'Unique voice',hash:'a'.repeat(64),runtime:{pending:true,reason:'Changed doors'},status:'valid'}} permissions={[{agent:'example',displayName:'Example',capability:'twenty',action:'',actionLabel:null,scope:'write-with-confirm',level:'gated',source:{kind:'definition'},controllable:true,lockedTools:[{tool:'delete',reason:'Always asks'}],evidence:{asked:0,autonomous:0,denied:0,locked:0,failedClosed:0,lastAt:null},answers:{approved:0,cancelled:0,neverAnswered:0,rate:null},couldGraduate:false}]}/>);
 expect(html).toContain('Unique duties');expect(html).toContain('Unique voice');expect(html).not.toContain('name="startingPoint"');
 expect(html).toContain('Apply connection changes (restarts agent)');expect(html).toMatch(/<button[^>]*type="button"[^>]*>Allow<\/button>/);expect(html).toContain('Always asks');expect(html).toContain('Start a fresh conversation now');
});
it('distinguishes unapproved capacity and a full box',()=>{
 expect(renderToStaticMarkup(<CeilingNotice capacity={{ceiling:null,activeCount:3,approved:false,creationAvailable:false}}/>)).toContain('not been measured and approved');
 expect(renderToStaticMarkup(<CeilingNotice capacity={{ceiling:0,activeCount:0,approved:true,creationAvailable:false}}/>)).toContain('Move to a server with agent capacity');
 expect(renderToStaticMarkup(<CeilingNotice capacity={{ceiling:1,activeCount:1,approved:true,creationAvailable:false}}/>)).toContain('up to 1 agent');
});

const startInitial=(over:any={})=>{
 const definition={...base.startingPoints[0].definition,name:'example',model:'example-brain'};
 return {definition,duties:'d',voice:'v',hash:'a'.repeat(64),runtime:{pending:false,reason:null,running:false,healthy:null},status:'valid',...over};
};
it('offers Start agent for a stopped valid agent and applies the saved definition with the hash',async()=>{
 vi.mocked(applyConnections).mockResolvedValue({ok:true} as any);
 render(<DefinitionForm {...base} initial={startInitial()}/>);
 expect(document.body.innerHTML).toContain('Agent stopped.');
 fireEvent.click([...document.querySelectorAll('button')].find(b=>b.textContent==='Start agent (applies saved definition)')!);
 await waitFor(()=>expect(applyConnections).toHaveBeenCalledWith({name:'example',hash:'a'.repeat(64)}));
});
it('does not offer Start agent for retired, invalid or running agents',()=>{
 for(const over of [{status:'retired'},{status:'invalid'},{runtime:{pending:false,reason:null,running:true,healthy:true}},{runtime:{pending:false,reason:null,running:true,healthy:false}},{runtime:{pending:false,reason:null,running:null,healthy:null}}]){
  const {unmount}=render(<DefinitionForm {...base} initial={startInitial(over)}/>);
  expect(document.body.innerHTML).not.toContain('Start agent (applies saved definition)');unmount();
 }
});
it('says plainly when a started agent is not answering yet, and when it runs',()=>{
 const {unmount}=render(<DefinitionForm {...base} initial={startInitial({runtime:{pending:false,reason:null,running:true,healthy:false}})}/>);
 expect(document.body.innerHTML).toContain('Started, not answering yet.');unmount();
 render(<DefinitionForm {...base} initial={startInitial({runtime:{pending:false,reason:null,running:true,healthy:true}})}/>);
 expect(document.body.innerHTML).toContain('Running. Saved connections are applied.');
});
it('shows current native activation hold ahead of pending details and offers no restart action',()=>{
 render(<DefinitionForm {...base} initial={startInitial({runtime:{pending:true,reason:'Native budget activation required',running:false,healthy:null}})}/>);
 expect(document.body.textContent).toContain('Native budget activation is required before this agent can start.');
 expect(document.body.textContent).not.toContain('Connection changes are pending.');
 expect(document.body.textContent).not.toContain('Apply connection changes (restarts agent)');
 expect(document.body.textContent).not.toContain('Start agent (applies saved definition)');
});
it('shows a grant the engine no longer knows, and removes it only when asked',()=>{
 const base0=startInitial();
 const definition={...base0.definition,grants:[...base0.definition.grants,{capability:'atlas',scope:'read'}],autonomy:{...base0.definition.autonomy,atlas:'gated'}} as any;
 render(<DefinitionForm {...base} initial={{...base0,definition}}/>);
 const html=document.body.innerHTML;
 expect(html).toContain('atlas');expect(html).toContain('no longer available in this version');
 fireEvent.click([...document.querySelectorAll('button')].find(b=>b.textContent==='Remove atlas')!);
 expect(document.body.innerHTML).not.toContain('no longer available in this version');
});
it('removing a retired grant also removes the skill that needs it, and Save becomes available',()=>{
 const base0=startInitial();
 const definition={...base0.definition,grants:[...base0.definition.grants,{capability:'gone-cap',scope:'read'}],autonomy:{...base0.definition.autonomy,'gone-cap':'gated'},skills:[...base0.definition.skills.filter((k:any)=>k.name!=='commercial'),{name:'commercial',description:'x',requires:[{capability:'gone-cap',scope:'read'}]}]} as any;
 render(<DefinitionForm {...base} initial={{...base0,definition}}/>);
 expect(document.body.innerHTML).toContain('Removing it also removes the skill');
 expect(document.body.innerHTML).toContain('commercial');
 fireEvent.click([...document.querySelectorAll('button')].find(b=>b.textContent==='Remove gone-cap')!);
 expect(document.body.innerHTML).not.toContain('no longer available in this version');
 expect(document.body.textContent).not.toContain('gone-cap');
 const save=[...document.querySelectorAll('button')].find(b=>b.textContent==='Save definition') as HTMLButtonElement;
 expect(save.disabled).toBe(false);
});
it('shows a skill the engine no longer knows with its own remove control',()=>{
 const base0=startInitial();
 const definition={...base0.definition,skills:[...base0.definition.skills,{name:'old-skill',description:'x',requires:[]}]} as any;
 render(<DefinitionForm {...base} initial={{...base0,definition}}/>);
 fireEvent.click([...document.querySelectorAll('button')].find(b=>b.textContent==='Remove skill old-skill')!);
 expect(document.body.innerHTML).not.toContain('old-skill');
});
it('shows no retired-grant notice for a current definition',()=>{
 render(<DefinitionForm {...base} initial={startInitial()}/>);
 expect(document.body.innerHTML).not.toContain('no longer available in this version');
});
