import { describe,expect,it,vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../app/actions/agent-access',()=>({adoptAgent:vi.fn(),saveAgentAccess:vi.fn()}));
import { AgentAccess } from '../components/AgentAccess';
describe('agent access controls',()=>{
  it('offers explicit self adoption bound to the displayed definition',()=>{
    const html=renderToStaticMarkup(<AgentAccess name="assistant" hash="current-fingerprint" access={undefined} members={[]}/>);
    expect(html).toContain('Adopt under my identity');expect(html).toContain('current-fingerprint');expect(html).toContain('requires your current owner capability policy');
    expect(html).toContain('Member conversations remain unavailable');expect(html).not.toContain('name="ownerId"');
  });
  it('shows revision, distinct use and editing controls, current expiry and no company-wide edit choice',()=>{
    const html=renderToStaticMarkup(<AgentAccess name="assistant" hash="current" access={{agentName:'assistant',ownerMemberId:'owner',accessRevision:14,definitionHash:'current',grants:[{principal:{kind:'member',id:'second'},permission:'edit',expiresAt:'2030-01-01T12:00:00.000Z'}]}} members={[{id:'owner',displayName:'Owner'},{id:'second',displayName:'Second member'}]}/>);
    expect(html).toContain('Access revision 14');expect(html).toContain('Named editors (editing does not grant use)');expect(html).toContain('Organisation, excluding restricted members');
    expect(html).toContain('2030-01-01T12:00:00.000Z');expect(html).toContain('Second member');expect(html).toContain('start a fresh conversation');
    expect(html).not.toContain('credential');expect(html).not.toContain('value="owner"');
  });
});
