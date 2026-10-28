"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { acceptOutsideDescriptorReview,discoverOutsideTools,inspectOutsideDiscovery,listOutsideDiscoveryTargets,previewOutsideDescriptorReview,
  previewOutsideDiscovery,publishOutsideDescriptorReview,stageOutsideCredentialCandidate,applyOutsideCredentialCandidate,
  previewOutsideCredentialApply,removeOutsideCredential } from "../app/actions/outside-discovery";
import type { OutsideDescriptorAcceptanceDto,OutsideDescriptorPublicationDto,OutsideDescriptorReviewDto,OutsideDiscoveryDocumentDto,
  OutsideDiscoveryPreviewDto,OutsideDiscoveryTargetDto,OutsidePendingApplyDto } from "../lib/outside-discovery-dto";

type Target=OutsideDiscoveryTargetDto;
type Preview=OutsideDiscoveryPreviewDto;
type Recovery={accountId:string;requestId:string;claimOperationId:string;agentName:string;connectionName:string};
type RemovalIdentity={accountId:string;agentName:string;connectionName:string;generation:number};
type Discovery=OutsideDiscoveryDocumentDto;
const RECOVERY_KEY="lares.outside.discovery.recovery.v1";
function recoveryKey(memberId:string):string{return `${RECOVERY_KEY}:${encodeURIComponent(memberId)}`;}
function recoveryIdentity(value:Recovery):string{return `${value.accountId}\0${value.requestId}\0${value.claimOperationId}\0${value.agentName}\0${value.connectionName}`;}
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
    [recovery,setRecovery]=useState<Recovery>(),[inspected,setInspected]=useState(false),[unresolved,setUnresolved]=useState(false),
    [descriptorReview,setDescriptorReview]=useState<OutsideDescriptorReviewDto>(),[publication,setPublication]=useState<OutsideDescriptorPublicationDto>(),
    [acceptance,setAcceptance]=useState<OutsideDescriptorAcceptanceDto>(),[staged,setStaged]=useState<OutsidePendingApplyDto>(),
    [applyUncertain,setApplyUncertain]=useState(false),[removalUncertain,setRemovalUncertain]=useState<RemovalIdentity>();
  const selectionRef=useRef(""),activeRecoveryRef=useRef<string|undefined>(undefined),reviewPreviewVersion=useRef(0),pendingApplyVersion=useRef(0),
    credentialMutationVersion=useRef(0);
  const selectedTarget=useMemo(()=>targets.find(t=>`${t.agentName}\0${t.connectionName}`===selected),[targets,selected]);

  useEffect(()=>{
    let active=true;
    void listOutsideDiscoveryTargets().then(items=>{if(active){setTargets(items);if(items.length){const first=`${items[0]!.agentName}\0${items[0]!.connectionName}`;
      selectionRef.current=first;setSelected(first);const target=items[0]!;if(target.credentialStatus.applyPending)void restorePendingApply(target,first);}}})
      .catch(()=>{if(active)setError("Private discovery connections are unavailable. Refresh membership to try again.");});
    try{
      const savedText=sessionStorage.getItem(memberRecoveryKey);
      if(savedText!==null){
        const saved=asRecovery(JSON.parse(savedText));
        if(!saved){setUnresolved(true);setInspected(true);setMessage("Saved discovery recovery information is incomplete. Its status cannot be confirmed; do not send consent again.");}
        else{setRecovery(saved);activeRecoveryRef.current=recoveryIdentity(saved);setUnresolved(true);void inspectOutsideDiscovery(saved).then(result=>{
        if(!active)return;
        setInspected(true);
        if(result?.state==="complete"){
          setDocument(result.document);setUnresolved(false);setInspected(true);setMessage("The saved discovery result is available for review.");
          void prepareDescriptorReview(saved);
        }else setMessage("This request has no confirmed result. Its status is unresolved; do not send the consent again.");
        }).catch(()=>{if(active){setInspected(true);setMessage("The saved request could not be inspected. Its status is unresolved; do not send the consent again.");}});}
      }
    }catch{if(active){setUnresolved(true);setInspected(true);setMessage("Recovery information could not be read, so a previous request may be unresolved. Do not send consent again.");}}
    return()=>{active=false;};
  },[memberRecoveryKey]);

  async function restorePendingApply(target:Target,selection:string){
    const version=++pendingApplyVersion.current;
    try{
      const pending=await previewOutsideCredentialApply({agentName:target.agentName,connectionName:target.connectionName});
      if(version!==pendingApplyVersion.current||selectionRef.current!==selection||pending.agentName!==target.agentName||pending.connectionName!==target.connectionName||
          pending.candidateRevision!==target.credentialStatus.candidateRevision)return;
      setStaged(pending);setApplyUncertain(false);setMessage("The exact pending custody revision was recovered from Keeper's saved stage evidence and is ready for Apply.");
    }catch{
      if(version===pendingApplyVersion.current&&selectionRef.current===selection)setError("The pending credential's exact Apply evidence is unavailable or ambiguous. Refresh status and review this connection again; if the old candidate still blocks staging, stop and contact the credential custodian for the normal custody resolution path.");
    }
  }

  async function prepareDescriptorReview(identity:Recovery){
    const version=++reviewPreviewVersion.current,identityKey=recoveryIdentity(identity),selection=`${identity.agentName}\0${identity.connectionName}`;
    setError("");setDescriptorReview(undefined);setPublication(undefined);setAcceptance(undefined);
    try{
      const review=await previewOutsideDescriptorReview(identity);
      if(version!==reviewPreviewVersion.current||selectionRef.current!==selection||activeRecoveryRef.current!==identityKey)return;
      setDescriptorReview(review);setMessage("Exact current tool descriptions are ready for your review. No credential has been staged.");
    }catch{if(version===reviewPreviewVersion.current&&selectionRef.current===selection&&activeRecoveryRef.current===identityKey)
      setError("These descriptions could not be prepared. Refresh the connection and review the discovery again.");}
  }

  async function loadTargets(){
    pendingApplyVersion.current++;
    if(!applyUncertain)setStaged(undefined);
    reviewPreviewVersion.current++;activeRecoveryRef.current=undefined;
    setBusy(true);setError("");
    try{const items=await listOutsideDiscoveryTargets();setTargets(items);
      if(removalUncertain){
        const exact=items.find(item=>item.agentName===removalUncertain.agentName&&item.connectionName===removalUncertain.connectionName&&
          item.credentialStatus.accountId===removalUncertain.accountId);
        if(exact?.credentialStatus.state==='revoked'&&!exact.credentialStatus.hasCredentialMaterial&&
            exact.credentialStatus.generation!==null&&exact.credentialStatus.generation>removalUncertain.generation){
          clearRemovedRecovery(removalUncertain);setRemovalUncertain(undefined);
          setMessage(`Keeper confirms removal for ${removalUncertain.agentName} · ${removalUncertain.connectionName}; audit receipts remain.`);
        }else if(exact?.credentialStatus.hasCredentialMaterial&&exact.credentialStatus.generation===removalUncertain.generation){
          setRemovalUncertain(undefined);setMessage(`The exact ${removalUncertain.agentName} · ${removalUncertain.connectionName} account remains at the requested generation with held material; removal did not commit.`);
        }else setMessage(`Removal remains unconfirmed for ${removalUncertain.agentName} · ${removalUncertain.connectionName}. Its exact account version is unavailable or has since changed; do not repeat the request.`);
      }
      if(items.length){const current=items.find(item=>`${item.agentName}\0${item.connectionName}`===selectionRef.current);
      const target=current??items[0]!;const selectedKey=`${target.agentName}\0${target.connectionName}`;
      selectionRef.current=selectedKey;setSelected(selectedKey);
      if(applyUncertain&&staged?.agentName===target.agentName&&staged.connectionName===target.connectionName){
        if(target.credentialStatus.activeRevision===staged.candidateRevision&&!target.credentialStatus.applyPending){
          setStaged(undefined);setApplyUncertain(false);setMessage(`Credential revision ${staged.candidateRevision} is active in Keeper custody. This does not confirm that the outside server is reachable or the agent is running.`);
        }else if(target.credentialStatus.applyPending&&target.credentialStatus.candidateRevision===staged.candidateRevision)void restorePendingApply(target,selectedKey);
      }else if(!applyUncertain&&target.credentialStatus.applyPending)void restorePendingApply(target,selectedKey);
    }if(!removalUncertain)setMessage(items.length?"Current connections loaded.":"No saved bearer connections are available for your agents.");}
    catch{setError("Private discovery connections are unavailable. Refresh membership to try again.");}
    finally{setBusy(false);}
  }
  function clearRemovedRecovery(identity:RemovalIdentity){
    try{
      const savedText=sessionStorage.getItem(memberRecoveryKey);
      const saved=savedText===null?undefined:asRecovery(JSON.parse(savedText));
      if(saved&&saved.accountId===identity.accountId&&saved.agentName===identity.agentName&&saved.connectionName===identity.connectionName){
        sessionStorage.removeItem(memberRecoveryKey);
        if(activeRecoveryRef.current===recoveryIdentity(saved))activeRecoveryRef.current=undefined;
        reviewPreviewVersion.current++;pendingApplyVersion.current++;
        setRecovery(undefined);setDocument(undefined);setPreview(undefined);setConsent(false);setCredential("");setInspected(false);
        setUnresolved(false);setDescriptorReview(undefined);setPublication(undefined);setAcceptance(undefined);setStaged(undefined);
      }
    }catch{/* Keep stale recovery if it cannot be safely matched and removed. */}
  }
  async function review(){
    if(!selectedTarget)return;
    reviewPreviewVersion.current++;activeRecoveryRef.current=undefined;
    setBusy(true);setError("");setMessage("");setDocument(undefined);setPreview(undefined);setConsent(false);setCredential("");setInspected(false);setUnresolved(false);
    setDescriptorReview(undefined);setPublication(undefined);setAcceptance(undefined);setStaged(undefined);
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
      activeRecoveryRef.current=recoveryIdentity(tuple);
      setRecovery(tuple);setConsent(true);
    }catch{setConsent(false);setError("Recovery information could not be saved in this tab. Consent cannot be sent.");}
  }
  async function consentAndDiscover(){
    if(!preview||!recovery||!consent||!credential||busy||unresolved||inspected)return;
    reviewPreviewVersion.current++;activeRecoveryRef.current=recoveryIdentity(recovery);
    setBusy(true);setConsent(false);setError("");setMessage("");setDocument(undefined);
    try{
      const result=await discoverOutsideTools({consent:true,requestId:preview.requestId,claimOperationId:preview.claimOperationId,
        accountId:preview.accountId,agentName:preview.agentName,connectionName:preview.connectionName,
        expectedGeneration:preview.expectedGeneration,expectedCandidateRevision:preview.expectedCandidateRevision,
        expectedDefinitionHash:preview.definitionHash,expectedAccessRevision:preview.accessRevision,
        expectedDestinationHash:preview.destinationHash,expectedRoutePolicyHash:preview.routePolicyHash,
        consentGeneration:preview.consentGeneration,credential});
      setCredential("");
      if(result.state==="complete"){setDocument(result.document);setInspected(true);setMessage("Discovery finished. Review the descriptions below.");void prepareDescriptorReview(recovery);return;}
      setUnresolved(true);setMessage("The request result is not confirmed. Checking its saved record without sending again.");
      const found=await inspectOutsideDiscovery(recovery);
      if(found.state==="complete"){setDocument(found.document);setUnresolved(false);setInspected(true);setMessage("The saved discovery result is available for review.");void prepareDescriptorReview(recovery);}
      else{setInspected(true);setMessage("No completed result is recorded. Its status is unresolved; do not send the consent again.");}
    }catch{
      // An action error can follow transmission, so only inspect the exact saved IDs.
      setCredential("");setUnresolved(true);setMessage("The request may have been sent. Checking its saved result without sending again.");
      try{const found=await inspectOutsideDiscovery(recovery);
        if(found.state==="complete"){setDocument(found.document);setUnresolved(false);setInspected(true);setMessage("The saved discovery result is available for review.");void prepareDescriptorReview(recovery);}
        else{setInspected(true);setMessage("No completed result is recorded. Its status is unresolved; do not send the consent again.");}
      }catch{setInspected(true);setMessage("The saved request could not be inspected. Its status is unresolved; do not send the consent again.");}
    }finally{setBusy(false);}
  }

  async function publishReviewedDescriptions(){
    if(!recovery||!descriptorReview||busy)return;
    setBusy(true);setError("");
    try{
      const result=await publishOutsideDescriptorReview({...recovery,expectedGeneration:descriptorReview.expectedGeneration,
        expectedDescriptorHash:descriptorReview.descriptorHash});
      setPublication(result);setMessage("These exact descriptions are recorded for acceptance. The credential is still not staged.");
    }catch{setError("The descriptions changed or could not be published. Refresh and review them again.");}
    finally{setBusy(false);}
  }

  async function acceptReviewedDescriptions(){
    if(!recovery||!publication||busy)return;
    setBusy(true);setError("");
    try{
      const result=await acceptOutsideDescriptorReview({...recovery,publicationId:publication.publicationId,expectedPublicationHash:publication.publicationHash});
      setAcceptance(result);setMessage("Exact tool descriptions accepted. Stage the credential candidate when ready.");
    }catch{setError("The descriptions could not be accepted under your current account access. Reload and review again.");}
    finally{setBusy(false);}
  }

  async function stageReviewedCandidate(){
    if(!recovery||!descriptorReview||!publication||!acceptance||busy)return;
    setBusy(true);setError("");
    try{
      const selectors={...recovery,publicationId:publication.publicationId,acceptanceId:acceptance.acceptanceId,
        expectedGeneration:descriptorReview.expectedGeneration,expectedCandidateRevision:descriptorReview.expectedCandidateRevision,
        expectedConsentGeneration:descriptorReview.expectedConsentGeneration,expectedDefinitionHash:descriptorReview.expectedDefinitionHash,
        expectedAccessRevision:descriptorReview.expectedAccessRevision,expectedPublicationHash:publication.publicationHash,
        expectedAcceptanceHash:acceptance.acceptanceHash};
      const receipt=await stageOutsideCredentialCandidate(selectors);
      setStaged({...selectors,activationReviewId:receipt.activationReviewId,activationReviewHash:receipt.activationReviewHash,
        expectedPolicyHash:receipt.expectedPolicyHash,stageOperationId:receipt.stageOperationId,candidateRevision:receipt.candidateRevision});
      setMessage("Credential candidate staged and pending Apply. It is not active.");
      const items=await listOutsideDiscoveryTargets();setTargets(items);
    }catch{
      try{
        const items=await listOutsideDiscoveryTargets();setTargets(items);
        setError("The stage result could not be confirmed. A pending candidate may be from an earlier attempt; refresh status before proceeding.");
      }catch{setError("The stage result could not be confirmed. Refresh status before trying again.");}
    }
    finally{setBusy(false);}
  }

  async function applyCandidate(){
    if(!staged||busy||applyUncertain||!selectedTarget||selectedTarget.agentName!==staged.agentName||selectedTarget.connectionName!==staged.connectionName||
        !selectedTarget.credentialStatus.applyPending||selectedTarget.credentialStatus.candidateRevision!==staged.candidateRevision)return;
    setBusy(true);setError("");setMessage("");
    try{
      const result=await applyOutsideCredentialCandidate(staged);
      setStaged(undefined);setApplyUncertain(false);setMessage(`Credential revision ${result.credentialRevision} is active in Keeper custody. This does not confirm that the outside server is reachable or the agent is running.`);
      try{setTargets(await listOutsideDiscoveryTargets());}catch{setError("Apply succeeded and Keeper confirmed the active custody revision, but the refreshed connection list is unavailable.");}
    }catch{
      setApplyUncertain(true);
      try{
        const current=await listOutsideDiscoveryTargets();setTargets(current);
        const target=current.find(item=>item.agentName===staged.agentName&&item.connectionName===staged.connectionName);
        if(target?.credentialStatus.activeRevision===staged.candidateRevision&&!target.credentialStatus.applyPending){
          setApplyUncertain(false);setMessage(`Credential revision ${staged.candidateRevision} is active in Keeper custody. This does not confirm that the outside server is reachable or the agent is running.`);
        }else if(target?.credentialStatus.applyPending&&target.credentialStatus.candidateRevision===staged.candidateRevision&&
            selectionRef.current===`${staged.agentName}\0${staged.connectionName}`){
          setError("Apply was not confirmed. The exact current candidate and evidence were recovered; review it before choosing Apply again.");
        }else setError("Apply could not be confirmed and the exact candidate is no longer current. Refresh status; no Apply action is available until the current revision is recovered.");
      }catch{setError("Apply could not be confirmed and current custody state is unavailable. Refresh before taking another action.");}
    }finally{setBusy(false);}
  }

  async function removeHeldCredential(){
    const target=selectedTarget,status=selectedTarget?.credentialStatus,selection=selectionRef.current,version=++credentialMutationVersion.current;
    if(!target||!status?.accountId||status.generation===null||!status.hasCredentialMaterial||busy||unresolved||applyUncertain||removalUncertain)return;
    const identity:RemovalIdentity={accountId:status.accountId,agentName:target.agentName,connectionName:target.connectionName,generation:status.generation};
    setBusy(true);setError("");setMessage("");
    const confirms=(items:Target[])=>items.find(item=>item.agentName===identity.agentName&&item.connectionName===identity.connectionName&&
      item.credentialStatus.accountId===identity.accountId&&item.credentialStatus.state==='revoked'&&!item.credentialStatus.hasCredentialMaterial&&
      item.credentialStatus.generation!==null&&item.credentialStatus.generation>identity.generation);
    try{
      await removeOutsideCredential({accountId:status.accountId,agentName:target.agentName,connectionName:target.connectionName,expectedGeneration:status.generation});
      const current=await listOutsideDiscoveryTargets();
      if(version!==credentialMutationVersion.current||selectionRef.current!==selection)return;
      setTargets(current);
      if(confirms(current)){clearRemovedRecovery(identity);setRemovalUncertain(undefined);setMessage("Keeper confirmed that use is stopped and the held credential material is removed. Non-secret audit receipts remain. Reconnect requires a fresh review and consent.");}
      else{setRemovalUncertain(identity);setError("The removal result could not be matched to this exact account version. Refresh custody status before another action.");}
    }catch{
      if(version!==credentialMutationVersion.current||selectionRef.current!==selection)return;
      try{
        const current=await listOutsideDiscoveryTargets();
        if(version!==credentialMutationVersion.current||selectionRef.current!==selection)return;
        setTargets(current);
        if(confirms(current)){clearRemovedRecovery(identity);setRemovalUncertain(undefined);setMessage("Keeper confirmed that use is stopped and the held credential material is removed. Non-secret audit receipts remain. Reconnect requires a fresh review and consent.");}
        else{setRemovalUncertain(identity);setError("Removal could not be confirmed for the exact account version. Refresh custody status before another action; do not repeat an uncertain request.");}
      }catch{setRemovalUncertain(identity);setError("Removal could not be confirmed and current custody status is unavailable. Refresh before taking another action.");}
    }finally{if(version===credentialMutationVersion.current)setBusy(false);}
  }

  return <section className="lares-stack" aria-label="Private outside-tool discovery">
    <h2>Discover available tools</h2>
    <p>Review a saved connection and, if you choose, share its bearer credential for one bounded description lookup. This does not enable or run tools.</p>
    {targets.length>0&&<label className="lares-field-label">Agent connection
      <select value={selected} disabled={busy||unresolved} onChange={event=>{pendingApplyVersion.current++;credentialMutationVersion.current++;if(!applyUncertain)setStaged(undefined);selectionRef.current=event.target.value;reviewPreviewVersion.current++;activeRecoveryRef.current=undefined;
        setSelected(event.target.value);setPreview(undefined);setConsent(false);setCredential("");setInspected(false);setDocument(undefined);
        setDescriptorReview(undefined);setPublication(undefined);setAcceptance(undefined);setStaged(undefined);
        const target=targets.find(item=>`${item.agentName}\0${item.connectionName}`===event.target.value);
        if(target?.credentialStatus.applyPending)void restorePendingApply(target,event.target.value);}}>
        {targets.map(target=><option key={`${target.agentName}:${target.connectionName}`} value={`${target.agentName}\0${target.connectionName}`}>{target.agentName} · {target.connectionName}</option>)}
      </select>
    </label>}
    {selectedTarget&&<p role="status">{removalUncertain?"The last credential-removal result is uncertain. Do not repeat it until the exact current custody state is confirmed.":applyUncertain?"The last Apply result is uncertain. No candidate is ready to Apply until the exact current custody state and evidence are recovered.":selectedTarget.credentialStatus.reviewPending&&selectedTarget.credentialStatus.applyPending
      ?selectedTarget.credentialStatus.state==='active-pending'
        ?"A completed discovery is pending review and a staged credential revision is pending Apply. The active saved revision remains in place."
        :"A completed discovery is pending review and a staged credential revision is pending Apply; no active saved revision is available."
      :selectedTarget.credentialStatus.state==='unavailable'&&selectedTarget.credentialStatus.reviewPending
      ?"A completed discovery is pending review; no active saved revision is available."
      :selectedTarget.credentialStatus.state==='active'&&selectedTarget.credentialStatus.reviewPending
        ?"A completed discovery is pending review. The active saved credential revision remains in place."
      :selectedTarget.credentialStatus.state==='unavailable'
      ?"Credential status is unavailable under your current account and connection access."
      :selectedTarget.credentialStatus.state==='revoked'
        ?selectedTarget.credentialStatus.hasCredentialMaterial?"Use is stopped, but Keeper still holds encrypted credential material. Remove it here or reconnect after review.":"Use is stopped and no credential material is held. A fresh review and consent can reconnect this account."
        :selectedTarget.credentialStatus.applyPending&&selectedTarget.credentialStatus.state==='pending'
          ?"A staged credential revision is pending Apply; no active saved revision is available."
        :selectedTarget.credentialStatus.applyPending
          ?"A staged credential revision is pending Apply. The previous active saved revision remains in place."
        :selectedTarget.credentialStatus.state==='active'
          ?"An active saved credential revision exists. This status does not confirm that the outside server is reachable."
          :"Credential status is unavailable under your current account and connection access."}</p>}
    <div className="lares-inline-form">
      <button type="button" disabled={busy||unresolved} onClick={()=>void loadTargets()}>Refresh connections</button>
      <button type="button" disabled={busy||unresolved||applyUncertain||!selectedTarget} onClick={()=>void review()}>Review connection</button>
    </div>
    {selectedTarget?.credentialStatus.hasCredentialMaterial&&<div className="lares-surface lares-stack">
      <strong>Credential custodian controls</strong>
      <p>This action immediately stops Lares use, invalidates pending work and approval revisions, removes held credential material from live Keeper rows, and keeps non-secret audit receipts. It does not revoke the key at its provider; backups may retain encrypted database snapshots.</p>
      <button type="button" disabled={busy||unresolved||applyUncertain||!!removalUncertain||!selectedTarget.credentialStatus.accountId||
        selectedTarget.credentialStatus.generation===null} onClick={()=>void removeHeldCredential()}>Stop use and remove held credential</button>
    </div>}
    {removalUncertain&&<div className="lares-surface lares-stack" role="status">
      <p>Removal is unconfirmed for {removalUncertain.agentName} · {removalUncertain.connectionName} at generation {removalUncertain.generation}. Do not repeat the request; another account’s status cannot resolve it.</p>
      <button type="button" disabled={busy} onClick={()=>void loadTargets()}>Refresh uncertain removal status</button>
    </div>}
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
    {descriptorReview&&<div className="lares-surface lares-stack" aria-label="Exact tool description review">
      <h3>Exact descriptions covered by this review</h3>
      <p>Connection: {descriptorReview.descriptor.connectionName} · Scope: {descriptorReview.descriptor.scope}</p>
      <p>Allowed tools: {descriptorReview.descriptor.allow.length?descriptorReview.descriptor.allow.join(", "):"none"}</p>
      <p>Read tools: {descriptorReview.descriptor.read.length?descriptorReview.descriptor.read.join(", "):"none"}</p>
      {descriptorReview.descriptor.tools.map(tool=><div className="lares-surface lares-stack" key={tool.name}>
        <strong>{tool.name}</strong>{tool.description&&<span>{tool.description}</span>}
        <pre>{JSON.stringify(tool.inputSchema,null,2)}</pre>
      </div>)}
      {!publication&&<button type="button" disabled={busy} onClick={()=>void publishReviewedDescriptions()}>Record these exact descriptions for acceptance</button>}
      {publication&&!acceptance&&<button type="button" disabled={busy} onClick={()=>void acceptReviewedDescriptions()}>Accept these exact descriptions</button>}
      {acceptance&&!staged&&<button type="button" disabled={busy} onClick={()=>void stageReviewedCandidate()}>Stage credential candidate</button>}
    </div>}
    {staged&&!applyUncertain&&<div className="lares-surface lares-stack" aria-label="Pending credential revision">
      <p role="status">Credential revision {staged.candidateRevision} is pending Apply and is not active.</p>
      <button type="button" disabled={busy||applyUncertain||selectedTarget?.agentName!==staged.agentName||selectedTarget.connectionName!==staged.connectionName||
        !selectedTarget.credentialStatus.applyPending||selectedTarget.credentialStatus.candidateRevision!==staged.candidateRevision}
        onClick={()=>void applyCandidate()}>{busy?"Applying credential…":"Apply credential revision"}</button>
      <p>Apply activates this exact credential revision in Keeper custody. It does not apply agent declarations or confirm runtime availability.</p>
    </div>}
  </section>;
}
