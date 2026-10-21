// @vitest-environment jsdom
import React from 'react';
import {beforeEach,expect,it,vi} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
const fake=vi.hoisted(()=>({member:vi.fn(),use:vi.fn(),agents:vi.fn(),chat:vi.fn()}));
vi.mock('../lib/auth',()=>({requireMember:fake.member}));
vi.mock('../lib/agents',()=>({listPrivateChatAgents:fake.agents}));
vi.mock('../lib/db',()=>({pool:{}}));
vi.mock('@lares/agent-kit/console-turn-authority',()=>({requireConsoleAgentUse:fake.use}));
vi.mock('../components/Chat',()=>({Chat:(props:unknown)=>{fake.chat(props);return <div>Private chat</div>;}}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('Not found');}}));
import ChatAgentPage from '../app/chat/[name]/page';
beforeEach(()=>{cleanup();vi.clearAllMocks();fake.member.mockResolvedValue({id:'Opaque-Member',role:'member'});fake.use.mockResolvedValue(undefined);fake.agents.mockResolvedValue([{name:'helper',displayName:'Helper',role:'Agent'}]);});
it('admits a granted member without owner inbox, reply seeds or account addresses',async()=>{
 render(await ChatAgentPage({params:Promise.resolve({name:'helper'})}));expect(screen.getByText('Private chat')).toBeDefined();
 expect(fake.chat).toHaveBeenCalledWith({name:'helper',memberId:'Opaque-Member',agents:[{name:'helper',displayName:'Helper',role:'Agent'}]});
 expect(fake.use).toHaveBeenCalledWith('helper','Opaque-Member',{});
});
it('checks current use before reading any agent metadata',async()=>{
 fake.use.mockRejectedValue(new Error('denied'));
 await expect(ChatAgentPage({params:Promise.resolve({name:'hidden'})})).rejects.toThrow('Not found');expect(fake.agents).not.toHaveBeenCalled();expect(fake.chat).not.toHaveBeenCalled();
});
