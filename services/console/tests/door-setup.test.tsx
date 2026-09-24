import {beforeEach,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ReactElement,ReactNode} from 'react';
const mocks=vi.hoisted(()=>({status:vi.fn(),states:[] as any[],setters:[] as any[]}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useEffect:()=>{},useState:(initial:unknown)=>{const i=mocks.setters.length,set=vi.fn();mocks.setters.push(set);return [mocks.states[i]??initial,set];}}));
vi.mock('../app/actions/definition',()=>({doorStatus:mocks.status}));
import {DoorSetup} from '../components/DoorSetup';
const props={name:'example',display:'Example',role:'creative',origin:'https://doors.example.test',hash:'a'.repeat(64)};
function find(node:ReactNode,label:string):ReactElement<{onClick:()=>void;disabled?:boolean}>|undefined {
 if(!node||typeof node!=='object')return;if(Array.isArray(node)){for(const c of node){const f=find(c,label);if(f)return f;}return;}
 const e=node as ReactElement<{children?:ReactNode;onClick:()=>void}>;if(e.type==='button'&&e.props.children===label)return e;return find(e.props?.children,label);
}
beforeEach(()=>{vi.clearAllMocks();mocks.states=[];mocks.setters=[];});
it('offers only role adapters and describes pending changes without claiming connected',()=>{
 mocks.states[0]=[{kind:'slack',enabled:true,claimed:true,pending:true,pending_reason:'Apply connection changes'}];
 const html=renderToStaticMarkup(DoorSetup(props));expect(html).toContain('Pending:');expect(html).toContain('Signing secret');expect(html).not.toContain('BotFather');expect(html).not.toContain('Connect mailbox with Google');expect(html).not.toContain('Owner connection applied');
});
it('keeps unknown outcome sticky after a later read failure and never retries the action',async()=>{
 mocks.states[4]=true;mocks.status.mockResolvedValue({ok:false,error:{message:'Read refused',outcomeMayBeUnknown:false}});
 const tree=DoorSetup(props);find(tree,'Refresh connection status')!.props.onClick();await vi.waitFor(()=>expect(mocks.status).toHaveBeenCalledTimes(1));
 await vi.waitFor(()=>expect(mocks.setters[4]).toHaveBeenCalled());
 const update=mocks.setters[4].mock.calls[0][0];expect(update(true)).toBe(true);
 expect(renderToStaticMarkup(tree)).toContain('A read-only status refresh does not unlock changes');
});
it('allows an existing applied chat door to be claimed without a new public webhook origin',()=>{
 mocks.states[0]=[{kind:'slack',enabled:true,claimed:false,pending:false}];
 const tree=DoorSetup({...props,origin:''});
 expect(find(tree,'Get one-time owner code')!.props.disabled).toBe(false);
 expect(renderToStaticMarkup(tree)).not.toContain('Create this Slack app from its manifest');
});
it.each([{enabled:false,claimed:false,pending:false},{enabled:true,claimed:false,pending:true},{enabled:true,claimed:true,pending:false}])('keeps unavailable existing doors unclaimable: %j',state=>{
 mocks.states[0]=[{kind:'slack',...state}];
 expect(find(DoorSetup({...props,origin:''}),'Get one-time owner code')!.props.disabled).toBe(true);
});
