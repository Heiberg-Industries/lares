import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
const mocks=vi.hoisted(()=>({retire:vi.fn(),refresh:vi.fn(),setters:[] as ReturnType<typeof vi.fn>[]}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:(initial:unknown)=>{const setter=vi.fn();mocks.setters.push(setter);return [initial,setter];}}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh,push:vi.fn()})}));
vi.mock('../app/actions/definition',()=>({retireAgent:mocks.retire}));
import { DefinitionForm } from '../components/DefinitionForm';
import { modelAliases,startingPoints } from '../lib/builder';
function retireButton(node:ReactNode):ReactElement<{onClick:()=>void}>|undefined {
 if(!node||typeof node!=='object')return;
 if(Array.isArray(node)){for(const child of node){const found=retireButton(child);if(found)return found;}return;}
 const element=node as ReactElement<{children?:ReactNode;onClick:()=>void}>;
 if(element.type==='button'&&element.props.children==='Retire agent')return element;
 return retireButton(element.props?.children);
}
beforeEach(()=>{vi.clearAllMocks();mocks.setters.length=0;});
it.each([
 [{ok:false,message:'Definition retained on disk; git backup failed. Check backup configuration and retry backup.'},'Agent retired. Definition retained on disk; git backup failed. Check backup configuration and retry backup.'],
 [{ok:true},'Agent retired.'],
])('shows successful retirement and its separate backup outcome: %j',async(backup,expected)=>{
 mocks.retire.mockResolvedValue({ok:true,result:{name:'example',status:'retired',archive:'example-archive',backup}});
 const points=startingPoints();
 const tree=DefinitionForm({startingPoints:points,aliases:modelAliases('example'),timing:{},capacity:{ceiling:3,activeCount:1,approved:true,creationAvailable:true},initial:{definition:{...points[0].definition,name:'example',model:'example-brain'},duties:'',voice:'',hash:'a'.repeat(64),status:'valid'}});
 const button=retireButton(tree);expect(button).toBeDefined();button!.props.onClick();
 await vi.waitFor(()=>expect(mocks.refresh).toHaveBeenCalledOnce());
 expect(mocks.retire).toHaveBeenCalledExactlyOnceWith({name:'example'});
 expect(mocks.setters.flatMap(setter=>setter.mock.calls.map(call=>call[0]))).toContain(expected);
});
