"use client";
import { useEffect, useMemo, useState } from "react";
import { discoverOutsideTools, inspectOutsideDiscovery, listOutsideDiscoveryTargets, previewOutsideDiscovery } from "../app/actions/outside-discovery";
import type { OutsideDiscoveryDocumentDto,OutsideDiscoveryPreviewDto,OutsideDiscoveryTargetDto } from "../lib/outside-discovery-dto";

type Target=OutsideDiscoveryTargetDto;
type Preview=OutsideDiscoveryPreviewDto;
type Recovery={accountId:string;requestId:string;claimOperationId:string;agentName:string;connectionName:string};
type Discovery=OutsideDiscoveryDocumentDto;
const RECOVERY_KEY="lares.outside.discovery.recovery.v1";
function recoveryKey(memberId:string):string{return `${RECOVERY_KEY}:${encodeURIComponent(memberId)}`;}
function asRecovery(value:unknown):Recovery|undefined{
  if(!value||typeof value!=="object")return;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")!=="accountId,agentName,claimOperationId,connectionName,requestId"||
      ![v.accountId,v.requestId,v.claimOperationId].every(x=>typeof x==="string"&&/^[0-9a-f-]{36}$/i.test(x))||
      ![v.agentName,v.connectionName].every(x=>typeof x==="string"))return;
  return value as Recovery;
}

export function OutsideDiscoverySection({memberId}:{memberId:string}){
  return <OutsideDiscoverySectionForMember key={memberId} memberId={memberId}/>;
}

function OutsideDiscoverySectionForMember({memberId}:{memberId:string}){
  const memberRecoveryKey=recoveryKey(memberId);
  const [targets,setTargets]=useState<Target[]>([]),[selected,setSelected]=useState(""),[preview,setPreview]=useState<Preview>(),
    [credential,setCredential]=useState(""),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),
    [message,setMessage]=useState(""),[error,setError]=useState(""),[document,setDocument]=useState<Discovery>(),
    [recovery,setRecovery]=useState<Recovery>(),[inspected,setInspected]=useState(false),[unresolved,setUnresolved]=useState(false);
  const selectedTarget=useMemo(()=>targets.find(t=>`${t.agentName}\0${t.connectionName}`===selected),[targets,selected]);

  useEffect(()=>{
    let active=true;
    void listOutsideDiscoveryTargets().then(items=>{if(active){setTargets(items);if(items.length)setSelected(`${items[0]!.agentName}\0${items[0]!.connectionName}`);}})
      .catch(()=>{if(active)setError("Private discovery connections are unavailable. Refresh membership to try again.");});
    try{
      const savedText=sessionStorage.getItem(memberRecoveryKey);
      if(savedText!==null){
        const saved=asRecovery(JSON.parse(savedText));
        if(!saved){setUnresolved(true);setInspected(true);setMessage("Saved discovery recovery information is incomplete. Its status cannot be confirmed; do not send consent again.");}
        else{setRecovery(saved);setUnresolved(true);void inspectOutsideDiscovery(saved).then(result=>{
        if(!active)return;
        setInspected(true);
        if(result?.state==="complete"){
          setDocument(result.document);setUnresolved(false);setInspected(true);setMessage("The saved discovery result is available for review.");
        }else setMessage("This request has no confirmed result. Its status is unresolved; do not send the consent again.");
        }).catch(()=>{if(active){setInspected(true);setMessage("The saved request could not be inspected. Its status is unresolved; do not send the consent again.");}});}
      }
    }catch{if(active){setUnresolved(true);setInspected(true);setMessage("Recovery information could not be read, so a previous request may be unresolved. Do not send consent again.");}}
    return()=>{active=false;};
  },[memberRecoveryKey]);

  async function loadTargets(){
    setBusy(true);setError("");
    try{const items=await listOutsideDiscoveryTargets();setTargets(items);if(items.length)setSelected(`${items[0]!.agentName}\0${items[0]!.connectionName}`);setMessage(items.length?"Current connections loaded.":"No saved bearer connections are available for your agents.");}
    catch{setError("Private discovery connections are unavailable. Refresh membership to try again.");}
    finally{setBusy(false);}
  }
  async function review(){
    if(!selectedTarget)return;
    setBusy(true);setError("");setMessage("");setDocument(undefined);setPreview(undefined);setConsent(false);setCredential("");setInspected(false);setUnresolved(false);
    try{setPreview(await previewOutsideDiscovery({agentName:selectedTarget.agentName,connectionName:selectedTarget.connectionName}));}
    catch{setError("This connection could not be reviewed. Refresh the list and try again.");}
    finally{setBusy(false);}
  }
  function enableConsent(checked:boolean){
    setError("");
    if(!checked){setConsent(false);return;}
    if(!preview)return;
    const tuple:Recovery={accountId:preview.accountId,requestId:preview.requestId,claimOperationId:preview.claimOperationId,
      agentName:preview.agentName,connectionName:preview.connectionName};
    try{
      // Persist synchronously before the only bearer-consent button becomes available.
      sessionStorage.setItem(memberRecoveryKey,JSON.stringify(tuple));
      setRecovery(tuple);setConsent(true);
    }catch{setConsent(false);setError("Recovery information could not be saved in this tab. Consent cannot be sent.");}
  }
  async function consentAndDiscover(){
    if(!preview||!recovery||!consent||!credential||busy||unresolved||inspected)return;
    setBusy(true);setConsent(false);setError("");setMessage("");setDocument(undefined);
    try{
      const result=await discoverOutsideTools({consent:true,requestId:preview.requestId,claimOperationId:preview.claimOperationId,
        accountId:preview.accountId,agentName:preview.agentName,connectionName:preview.connectionName,
        expectedGeneration:preview.expectedGeneration,expectedCandidateRevision:preview.expectedCandidateRevision,
        expectedDefinitionHash:preview.definitionHash,expectedAccessRevision:preview.accessRevision,
        expectedDestinationHash:preview.destinationHash,expectedRoutePolicyHash:preview.routePolicyHash,
        consentGeneration:preview.consentGeneration,credential});
      setCredential("");
      if(result.state==="complete"){setDocument(result.document);setInspected(true);setMessage("Discovery finished. Review the descriptions below.");return;}
      setUnresolved(true);setMessage("The request result is not confirmed. Checking its saved record without sending again.");
      const found=await inspectOutsideDiscovery(recovery);
      if(found.state==="complete"){setDocument(found.document);setUnresolved(false);setInspected(true);setMessage("The saved discovery result is available for review.");}
      else{setInspected(true);setMessage("No completed result is recorded. Its status is unresolved; do not send the consent again.");}
    }catch{
      // An action error can follow transmission, so only inspect the exact saved IDs.
      setCredential("");setUnresolved(true);setMessage("The request may have been sent. Checking its saved result without sending again.");
      try{const found=await inspectOutsideDiscovery(recovery);
        if(found.state==="complete"){setDocument(found.document);setUnresolved(false);setInspected(true);setMessage("The saved discovery result is available for review.");}
        else{setInspected(true);setMessage("No completed result is recorded. Its status is unresolved; do not send the consent again.");}
      }catch{setInspected(true);setMessage("The saved request could not be inspected. Its status is unresolved; do not send the consent again.");}
    }finally{setBusy(false);}
  }

  return <section className="lares-stack" aria-label="Private outside-tool discovery">
    <h2>Discover available tools</h2>
    <p>Review a saved connection and, if you choose, share its bearer credential for one bounded description lookup. This does not enable or run tools.</p>
    {targets.length>0&&<label className="lares-field-label">Agent connection
      <select value={selected} disabled={busy||unresolved} onChange={event=>{setSelected(event.target.value);setPreview(undefined);setConsent(false);setCredential("");setInspected(false);setDocument(undefined);}}>
        {targets.map(target=><option key={`${target.agentName}:${target.connectionName}`} value={`${target.agentName}\0${target.connectionName}`}>{target.agentName} · {target.connectionName}</option>)}
      </select>
    </label>}
    <div className="lares-inline-form">
      <button type="button" disabled={busy||unresolved} onClick={()=>void loadTargets()}>Refresh connections</button>
      <button type="button" disabled={busy||unresolved||!selectedTarget} onClick={()=>void review()}>Review connection</button>
    </div>
    {preview&&<div className="lares-surface lares-stack">
      <strong>Exact destination</strong><code>{preview.endpoint}</code>
      <p>Purpose: read the tool descriptions once, using the current reviewed network route.</p>
      <label className="lares-field-label">Bearer credential
        <input type="password" autoComplete="off" value={credential} disabled={busy||unresolved||inspected} onChange={event=>setCredential(event.target.value)} />
      </label>
      <label><input type="checkbox" checked={consent} disabled={busy||unresolved||inspected} onChange={event=>enableConsent(event.target.checked)} /> I consent to this one discovery request for the destination and purpose shown above.</label>
      <button type="button" disabled={busy||unresolved||inspected||!consent||credential.length===0} onClick={()=>void consentAndDiscover()}>
        Send one discovery request
      </button>
      <p>The credential is not saved in browser storage. If the result is uncertain, this page checks the saved request and never sends it again.</p>
    </div>}
    {busy&&<p role="status">Working…</p>}{message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
    {recovery&&<p>Recovery reference saved for {recovery.agentName} · {recovery.connectionName}.</p>}
    {document&&<div className="lares-stack" aria-label="Discovered tool descriptions">
      <p>{document.serverInfo.name} {document.serverInfo.version} · {document.tools.length} tools found</p>
      {document.tools.map(tool=><div className="lares-surface lares-stack" key={tool.name}><strong>{tool.name}</strong>{tool.description&&<span>{tool.description}</span>}</div>)}
    </div>}
  </section>;
}
