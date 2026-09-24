import { expect,it } from 'vitest';
import { assertSkillsWithinGrants } from '@lares/agent-kit/skill-grants';
it('refuses missing and too-narrow grants in the browser predicate',()=>{
 const skills=[{name:'commercial',requires:[{capability:'twenty',scope:'read' as const}]}];
 expect(()=>assertSkillsWithinGrants({skills,grants:[]})).toThrow(/never widen/);
 expect(()=>assertSkillsWithinGrants({skills,grants:[{capability:'twenty',scope:'none'}]})).toThrow(/never widen/);
 expect(()=>assertSkillsWithinGrants({skills:[{name:'commercial',requires:[{capability:'twenty',scope:'write'}]}],grants:[{capability:'twenty',scope:'read'}]})).toThrow(/never widen/);
 expect(()=>assertSkillsWithinGrants({skills,grants:[{capability:'twenty',scope:'read'}]})).not.toThrow();
});
it('does not accept unknown skills or capabilities',()=>{
 expect(()=>assertSkillsWithinGrants({skills:[{name:'typo',requires:[]}],grants:[]})).toThrow(/unknown skill/);
 expect(()=>assertSkillsWithinGrants({skills:[{name:'commercial',requires:[{capability:'typo',scope:'read'}]}],grants:[]})).toThrow(/unknown capability/);
});
