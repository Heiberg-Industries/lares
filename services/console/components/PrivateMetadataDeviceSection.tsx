"use client";
import { useState } from 'react';
import { createPrivateMetadataDataset,issuePrivateMetadataDevice,previewPrivateMetadataTarget,privateMetadataDeviceStatus,revokePrivateMetadataDevice } from '../app/actions/private-metadata';

type Target=Awaited<ReturnType<typeof previewPrivateMetadataTarget>>;
type Dataset=Awaited<ReturnType<typeof createPrivateMetadataDataset>>;
type Issued=Awaited<ReturnType<typeof issuePrivateMetadataDevice>>;
type DeviceStatus=Awaited<ReturnType<typeof privateMetadataDeviceStatus>>;

export function PrivateMetadataDeviceSection(){
  const [agentName,setAgentName]=useState(''),[target,setTarget]=useState<Target>(),[dataset,setDataset]=useState<Dataset>(),
    [issued,setIssued]=useState<Issued>(),[device,setDevice]=useState<DeviceStatus>(),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function preview(){setBusy(true);setMessage('');setIssued(undefined);setDevice(undefined);setConsent(false);try{const result=await previewPrivateMetadataTarget(agentName);
    const current=await privateMetadataDeviceStatus(agentName);setTarget(result);setDevice(current??undefined);
    setDataset(current?{accountId:current.accountId,generation:current.accountGeneration,resourceBindingId:current.resourceBindingId,datasetId:current.datasetId}:undefined);
    setMessage('Review the exact configured descriptor and purpose below before consenting.');}
    catch(error){setMessage(error instanceof Error?error.message:'Descriptor preview is unavailable.');}finally{setBusy(false);}}
  async function issue(){if(!target||!consent)return;setBusy(true);setMessage('');setIssued(undefined);try{
    const selected=dataset??await createPrivateMetadataDataset();setDataset(selected);
    const result=await issuePrivateMetadataDevice({accountId:selected.accountId,resourceBindingId:selected.resourceBindingId,agentName:target.agentName,
      connectionName:target.connectionName,expectedDescriptorFingerprint:target.descriptorFingerprint,consent:true});
    setIssued(result);setDevice({accountId:selected.accountId,resourceBindingId:selected.resourceBindingId,datasetId:selected.datasetId,
      accountGeneration:result.accountGeneration,deviceId:result.deviceId,deviceGeneration:result.deviceGeneration,state:'active'});
    setMessage('Upload credential created. It is shown once; enter it in the Mac setup command now.');
  }catch(error){setMessage(error instanceof Error?error.message:'Enrollment could not be confirmed. Refresh status before retrying.');}finally{setBusy(false);}}
  async function revoke(){if(!device)return;setBusy(true);setMessage('');try{const result=await revokePrivateMetadataDevice(device.deviceId,device.deviceGeneration);
    setIssued(undefined);setDevice({...device,state:'revoked'});setMessage(`Device access revoked (generation ${result.generation}).`);}
    catch(error){setMessage(error instanceof Error?error.message:'Revocation could not be confirmed. Refresh status before retrying.');}finally{setBusy(false);}}
  return <section className="lares-surface lares-stack" aria-label="Private metadata Mac access">
    <h2>Private metadata on Mac</h2>
    <p>Review the current read-only lookup connection, then explicitly authorize your own private dataset. The upload credential is shown once and cannot read data.</p>
    <label>Agent name<input value={agentName} onChange={event=>setAgentName(event.target.value)} autoComplete="off" /></label>
    <button type="button" disabled={busy||agentName.length<2} onClick={()=>void preview()}>{busy?'Checking…':'Review current connection'}</button>
    {target&&<div className="lares-stack">
      <p><strong>{target.purpose}</strong></p><p>Connection: {target.connectionName}</p>
      <p>Descriptor fingerprint: <code>{target.descriptorFingerprint}</code></p><p>Allowed tools: {target.tools.join(', ')}</p>
      <label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} /> I authorize this exact descriptor to access my private dataset for read-only lookup.</label>
      <button type="button" disabled={busy||!consent} onClick={()=>void issue()}>{busy?'Saving…':device?'Replace device and issue upload credential':'Create dataset and issue upload credential'}</button>
    </div>}
    {dataset&&<p>Private dataset created: <code>{dataset.datasetId}</code></p>}
    {issued&&<div className="lares-stack" role="status">
      <p>Copy this upload credential into the Mac CLI now. This is the only time it will be shown.</p>
      <code style={{overflowWrap:'anywhere',userSelect:'all'}}>{issued.uploadToken}</code>
      <p>Account generation {issued.accountGeneration}.</p>
    </div>}
    {device&&<div className="lares-stack" role="status">
      <p>Device {device.deviceId} is {device.state}. Account generation {device.accountGeneration}.</p>
      {device.state==='active'&&<button type="button" disabled={busy} onClick={()=>void revoke()}>Revoke this device</button>}
    </div>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
