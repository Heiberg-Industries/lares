import {beforeEach,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ReactElement,ReactNode} from 'react';
import {Button} from '@lares/ui/primitives/button';
const mocks=vi.hoisted(()=>({
  status:vi.fn(),connect:vi.fn(),verify:vi.fn(),enable:vi.fn(),apply:vi.fn(),webhook:vi.fn(),claim:vi.fn(),
  states:[] as any[],setters:[] as any[],
}));
// Order of useState calls in DoorSetup: rows, progress, message, error, unknown, connect, tokens, signing.
const STATE={rows:0,progress:1,message:2,error:3,unknown:4,connect:5,tokens:6,signing:7};
vi.mock('react',async original=>({...await original<typeof import('react')>(),useEffect:()=>{},useRef:(v:unknown)=>({current:v}),useState:(initial:unknown)=>{const i=mocks.setters.length,set=vi.fn();mocks.setters.push(set);return [mocks.states[i]??initial,set];}}));
vi.mock('../app/actions/definition',()=>({doorStatus:mocks.status,connectDoor:mocks.connect,verifyDoor:mocks.verify,setDoorEnabled:mocks.enable,applyConnections:mocks.apply,registerTelegram:mocks.webhook,claimCode:mocks.claim}));
import {DoorSetup} from '../components/DoorSetup';
const props={name:'example',display:'Example',role:'creative',origin:'https://doors.example.test',hash:'a'.repeat(64)};
const cos={...props,role:'chief-of-staff'};
function find(node:ReactNode,label:string):ReactElement<{onClick:()=>void;disabled?:boolean}>|undefined {
 if(!node||typeof node!=='object')return;if(Array.isArray(node)){for(const c of node){const f=find(c,label);if(f)return f;}return;}
 const e=node as ReactElement<{children?:ReactNode;onClick:()=>void}>;if((e.type==='button'||e.type===Button)&&e.props.children===label)return e;return find(e.props?.children,label);
}
function findAll(node:ReactNode,label:string,out:ReactElement<{onClick:()=>void;disabled?:boolean}>[]=[]) {
 if(!node||typeof node!=='object')return out;if(Array.isArray(node)){for(const c of node)findAll(c,label,out);return out;}
 const e=node as ReactElement<{children?:ReactNode;onClick:()=>void}>;if((e.type==='button'||e.type===Button)&&e.props.children===label)out.push(e);findAll(e.props?.children,label,out);return out;
}
const ok=<T,>(result:T)=>({ok:true as const,result});
const row=(kind:string,over:object={})=>({kind,enabled:false,configured:false,claimed:false,pending:false,applied:false,...over});
beforeEach(()=>{vi.clearAllMocks();mocks.states=[];mocks.setters=[];});
it('offers only role adapters and describes pending changes without claiming connected',()=>{
 mocks.states[STATE.rows]=[row('slack',{enabled:true,configured:true,claimed:true,pending:true,pending_reason:'Apply connection changes'})];
 const html=renderToStaticMarkup(DoorSetup(props));expect(html).toContain('Pending:');expect(html).toContain('Signing secret');expect(html).not.toContain('BotFather');expect(html).not.toContain('Connect mailbox with Google');expect(html).not.toContain('Owner connection applied');
});
it('never shows Pending for a door the owner has not touched, even while the agent has changes waiting',()=>{
 mocks.states[STATE.rows]=[row('slack',{enabled:true,configured:true,pending:true,pending_reason:'Apply connection changes'}),row('telegram',{pending:true,pending_reason:'Apply connection changes'}),row('email',{pending:true})];
 const html=renderToStaticMarkup(DoorSetup(cos));
 expect(html.match(/Pending:/g)).toHaveLength(1);expect(html).toContain('Not set up');
});
it('has no refresh button, and shows a prominent pending state while an apply runs',()=>{
 mocks.states[STATE.rows]=[row('slack',{enabled:true,configured:true})];mocks.states[STATE.progress]='Applying (restarts the agent, about a minute)…';
 const tree=DoorSetup(props);const html=renderToStaticMarkup(tree);
 expect(find(tree,'Refresh connection status')).toBeUndefined();expect(html).not.toContain('Refresh connection status');
 expect(html).toContain('lares-door-progress');expect(html).toContain('Applying (restarts the agent, about a minute)');
});
it('shows the Apply button only when a door the owner touched is waiting',()=>{
 mocks.states[STATE.rows]=[row('slack'),row('telegram',{pending:true})];
 expect(find(DoorSetup(cos),'Apply connection changes (restarts agent)')).toBeUndefined();
 mocks.setters=[];mocks.states[STATE.rows]=[row('slack',{enabled:true,configured:true,pending:true})];
 expect(find(DoorSetup(cos),'Apply connection changes (restarts agent)')).toBeDefined();
});
it('shows a single tap-to-connect link for Telegram once the door is applied',()=>{
 mocks.states[STATE.rows]=[row('telegram',{enabled:true,configured:true,applied:true})];
 mocks.states[STATE.connect]={kind:'telegram',code:'A'.repeat(24),expiresAt:new Date(Date.now()+600000).toISOString(),username:'example_bot',link:`https://t.me/example_bot?start=${'A'.repeat(24)}`};
 const html=renderToStaticMarkup(DoorSetup(cos));
 expect(html).toContain('Tap to connect');expect(html).toContain(`href="https://t.me/example_bot?start=${'A'.repeat(24)}"`);
});
it('tells the owner the one message to send in Slack',()=>{
 mocks.states[STATE.rows]=[row('slack',{enabled:true,configured:true,applied:true})];
 mocks.states[STATE.connect]={kind:'slack',code:'B'.repeat(24),expiresAt:new Date(Date.now()+600000).toISOString(),message:`claim ${'B'.repeat(24)}`,who:'bot in Team'};
 const html=renderToStaticMarkup(DoorSetup(props));
 expect(html).toContain(`claim ${'B'.repeat(24)}`);expect(html).toContain('bot in Team');expect(html).toContain('Copy manifest');
});
it('connects Telegram from the token alone: save, check, enable, apply, register, then issue the link',async()=>{
 const order:string[]=[];
 mocks.status.mockImplementation(async()=>{order.push('status');return ok([row('telegram',{configured:true,enabled:order.includes('enable'),pending:!order.includes('apply')})]);});
 mocks.connect.mockImplementation(async()=>{order.push('connect');return ok({});});
 mocks.verify.mockImplementation(async()=>{order.push('verify');return ok({kind:'telegram',username:'example_bot'});});
 mocks.enable.mockImplementation(async()=>{order.push('enable');return ok({hash:'b'.repeat(64),backup:{ok:true}});});
 mocks.apply.mockImplementation(async()=>{order.push('apply');return ok({});});
 mocks.webhook.mockImplementation(async()=>{order.push('webhook');return ok({registered:true});});
 mocks.claim.mockImplementation(async()=>{order.push('claim');return ok({code:'C'.repeat(24),expiresAt:new Date().toISOString(),instruction:''});});
 mocks.states[STATE.tokens]={telegram:'123:abc'};
 const tree=DoorSetup(cos);findAll(tree,'Connect')[1].props.onClick();
 await vi.waitFor(()=>expect(order).toContain('claim'));
 expect(order.filter(s=>s!=='status')).toEqual(['connect','verify','enable','apply','webhook','verify','claim']);
 expect(mocks.connect).toHaveBeenCalledWith({name:'example',kind:'telegram',secret:'123:abc'});
 expect(mocks.apply).toHaveBeenCalledWith({name:'example',hash:'b'.repeat(64)});
 await vi.waitFor(()=>{const calls=mocks.setters[STATE.connect].mock.calls;expect(calls.at(-1)?.[0]).toMatchObject({kind:'telegram',link:`https://t.me/example_bot?start=${'C'.repeat(24)}`});});
});
it('keeps unknown outcome sticky after a failed step and offers a reload',async()=>{
 mocks.states[STATE.unknown]=true;mocks.states[STATE.rows]=[row('slack',{enabled:true,configured:true,pending:true})];
 const html=renderToStaticMarkup(DoorSetup(props));
 expect(html).toContain('Reload this agent’s current state');
});
it('lets an already applied, unclaimed chat door be connected without a new public webhook origin',()=>{
 mocks.states[STATE.rows]=[row('slack',{enabled:true,configured:true,applied:true})];
 const tree=DoorSetup({...props,origin:''});
 expect(find(tree,'Show the one-time code')).toBeDefined();
 expect(renderToStaticMarkup(tree)).not.toContain('Create this Slack app from its manifest');
});
it.each([{enabled:false,pending:false},{enabled:true,pending:true},{enabled:true,claimed:true,pending:false}])('keeps unavailable existing doors from offering a code: %j',state=>{
 mocks.states[STATE.rows]=[row('slack',{configured:true,...state})];
 expect(find(DoorSetup({...props,origin:''}),'Show the one-time code')).toBeUndefined();
});
