"use client";
import {useActionState} from "react";
import {setInitialMemberLimit,type InitialLimitResult} from "../app/actions/members";

type Member={id:string;displayName:string;eligible:boolean;setupComplete:boolean};
function MemberLimitForm({member}:{member:Member}) {
  const [state,action,pending]=useActionState<InitialLimitResult,FormData>(setInitialMemberLimit,{});
  return <form action={action} className="lares-stack">
    <input type="hidden" name="memberId" value={member.id}/>
    <label>Initial monthly limit (USD) <input name="monthlyLimit" type="text" inputMode="decimal" required maxLength={37} placeholder="e.g. 25"/></label>
    <button type="submit" disabled={pending}>{pending?"Saving limit…":"Save initial limit"}</button>
    {state.error&&<p role="alert">{state.error}</p>}
    {state.saved&&<p role="status">Initial monthly limit saved. Spending stays off until budget setup is complete.</p>}
  </form>;
}

export function InitialMemberBudgetSetup({members,unavailable=false}:{members:Member[];unavailable?:boolean}) {
  const eligible=members.filter(member=>member.eligible);
  const completed=members.filter(member=>member.setupComplete);
  return <section className="lares-surface lares-stack">
    <h2 className="lares-section-title">Initial member spending limits</h2>
    <p>Choose a first monthly limit for each active member with a verified sign-in. Enter a positive USD amount as digits and a decimal point, for example 25 or 25.5. Spending stays off until the remaining budget setup is complete.</p>
    {unavailable&&<p role="status">Initial limit status unavailable. Member directory and invitations remain available; refresh this page to check again.</p>}
    {!unavailable&&eligible.map(member=><div key={member.id} className="lares-stack"><h3>{member.displayName}</h3><MemberLimitForm member={member}/></div>)}
    {!unavailable&&completed.map(member=><p key={member.id}><strong>{member.displayName}</strong> · Initial budget setup is already recorded; this first limit cannot be changed here.</p>)}
    {!unavailable&&!eligible.length&&!completed.length&&<p>No active verified members need an initial limit.</p>}
  </section>;
}
