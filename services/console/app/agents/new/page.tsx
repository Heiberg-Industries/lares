import { builderData } from '../../../lib/builder';
import { DefinitionForm } from '../../../components/DefinitionForm';
export const dynamic='force-dynamic';
export default async function NewAgentPage() {
  try { const data=await builderData(); return <><h1>Create an agent</h1><DefinitionForm {...data}/></>; }
  catch(error) { return <><h1>Create an agent</h1><p role="alert">The builder is unavailable: {error instanceof Error?error.message:'Could not load keeper state.'}</p></>; }
}
