import { builderData, editedOutsideTheConsole } from '../../../../lib/builder';
import { DefinitionForm } from '../../../../components/DefinitionForm';
export const dynamic='force-dynamic';
export default async function EditAgentPage({params}:{params:Promise<{name:string}>}) {
  const {name}=await params;
  try {
    const data=await builderData(name);
    const outside=await editedOutsideTheConsole(name);
    return <><h1>Edit {name}</h1><p><a href={`/agents/${encodeURIComponent(name)}`}>Agent overview</a></p>{outside&&<p>Changed outside the console, {new Date(outside.at).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'})}.</p>}<DefinitionForm {...data}/></>;
  } catch(error) { return <><h1>Edit {name}</h1><p role="alert">The builder is unavailable: {error instanceof Error?error.message:'Could not load keeper state.'}</p></>; }
}
