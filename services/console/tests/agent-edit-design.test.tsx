// @vitest-environment jsdom
import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {render,screen,cleanup,fireEvent,waitFor,within} from '@testing-library/react';
import {saveDefinition} from '../app/actions/definition';
import {DefinitionForm} from '../components/DefinitionForm';
import {startingPoints,modelAliases,takesEffect} from '../lib/builder';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../app/actions/definition',()=>({createAgent:vi.fn(),saveDefinition:vi.fn(),retireAgent:vi.fn(),deleteAgent:vi.fn(),applyConnections:vi.fn()}));
vi.mock('../app/actions/autonomy',()=>({setAutonomy:vi.fn()}));
vi.mock('../components/AvatarEditor',()=>({AvatarEditor:()=><section>Picture</section>}));
vi.mock('../components/DoorSetup',()=>({DoorSetup:()=><section>Doors setup</section>}));
vi.mock('../components/ConversationControl',()=>({ConversationControl:()=>null}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const base={startingPoints:startingPoints(),aliases:modelAliases('example'),timing:Object.fromEntries(['name','gender','description','startingPoint','duties','voice','language','model','grants','skills','autonomy','schedules','doors'].map(f=>[f,takesEffect(f)])),capacity:{ceiling:6,activeCount:3,approved:true,creationAvailable:true,canChange:true}};
const initial={definition:{...base.startingPoints[0].definition,name:'example',model:'example-brain',language:'English'},duties:'d',voice:'v',hash:'a'.repeat(64),runtime:{pending:false,reason:null,running:true,healthy:true},status:'valid'};
const edit=()=>render(<DefinitionForm {...base} initial={initial as never}/>);
const order=(a:Element,b:Element)=>Boolean(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING);

it('puts who the agent is and what it can do side by side, with status first and lifecycle last',()=>{
 edit();
 const who=screen.getByRole('heading',{name:'Who it is'}),what=screen.getByRole('heading',{name:'What it can do'});
 const grid=who.closest('.lares-grid');expect(grid).not.toBeNull();expect(grid!.contains(what)).toBe(true);
 expect(who.closest('.lares-surface')).not.toBe(what.closest('.lares-surface'));
 const status=screen.getByRole('heading',{name:'Status'}),lifecycle=screen.getByRole('heading',{name:'Agent lifecycle'});
 expect(order(status,who)).toBe(true);expect(order(screen.getByText('Doors setup'),lifecycle)).toBe(true);
 // Everything on the page is shown, not folded away behind summaries.
 expect(document.querySelectorAll('details.lares-disclosure')).toHaveLength(0);
});

it('has one primary button, Save, in a bar that says when there are unsaved changes',()=>{
 edit();
 const bar=screen.getByRole('button',{name:'Save definition'}).closest('.lares-save-bar') as HTMLElement;
 expect(bar).not.toBeNull();expect(bar.hasAttribute('data-dirty')).toBe(false);
 fireEvent.change(screen.getByLabelText('Display name'),{target:{value:'Example'}});
 expect(bar.hasAttribute('data-dirty')).toBe(true);expect(within(bar).getByText('Unsaved changes')).toBeDefined();
 const primary=[...document.querySelectorAll('button[data-variant="default"]')].map(b=>b.textContent);
 expect(primary).toEqual(['Save definition']);
});

it('after a save that could not be confirmed, offers a reload at the top and stops warning about unsaved changes',async()=>{
 vi.mocked(saveDefinition).mockResolvedValue({ok:false,error:{message:'The keeper did not answer in time.',outcomeMayBeUnknown:true}} as never);
 edit();
 fireEvent.change(screen.getByLabelText('Display name'),{target:{value:'Example'}});
 fireEvent.click(screen.getByRole('button',{name:'Save definition'}));
 const reload=await screen.findByRole('button',{name:'Reload this agent’s current state'});
 expect(order(reload,screen.getByRole('heading',{name:'Who it is'}))).toBe(true);
 expect(screen.getByRole('alert').textContent).toMatch(/could not be confirmed/);
 const leaving=new Event('beforeunload',{cancelable:true});window.dispatchEvent(leaving);
 expect(leaving.defaultPrevented).toBe(false);
 fireEvent.click(screen.getByText('Open the permissions board'));
 await waitFor(()=>expect(screen.queryByText('Leave unsaved changes?')).toBeNull());
});
