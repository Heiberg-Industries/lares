"use client";
import {useActionState} from "react";
import {Field,Notice,Row,Rows} from "@lares/ui/patterns";
import {Button} from "@lares/ui/primitives/button";
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from "@lares/ui/primitives/card";
import {Input} from "@lares/ui/primitives/input";
import {setInitialMemberLimit,type InitialLimitResult} from "../app/actions/members";

type Member={id:string;displayName:string;eligible:boolean;setupComplete:boolean};
function MemberLimitForm({member}:{member:Member}) {
  const [state,action,pending]=useActionState<InitialLimitResult,FormData>(setInitialMemberLimit,{});
  return <form action={action} className="lares-stack">
    <input type="hidden" name="memberId" value={member.id}/>
    <div className="lares-inline-form">
      <Field label="First monthly limit (USD)"><Input name="monthlyLimit" type="text" inputMode="decimal" required maxLength={37} placeholder="e.g. 25" aria-label={`First monthly limit for ${member.displayName} (USD)`}/></Field>
      <Button type="submit" variant="outline" disabled={pending}>{pending?"Saving limit…":"Save first limit"}</Button>
    </div>
    {state.error&&<Notice error>{state.error}</Notice>}
    {state.saved&&<Notice tone="success">First monthly limit saved. Spending stays off until budget setup is complete.</Notice>}
  </form>;
}

export function InitialMemberBudgetSetup({members,unavailable=false}:{members:Member[];unavailable?:boolean}) {
  const eligible=members.filter(member=>member.eligible);
  const completed=members.filter(member=>member.setupComplete);
  return <Card>
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>First spending limits</CardTitle>
      <CardDescription>Choose a first monthly limit for each active member who has signed in. Type a positive amount in US dollars using digits and a decimal point, for example 25 or 25.5. Spending stays off until the rest of the budget setup is complete.</CardDescription>
    </CardHeader>
    {unavailable&&<CardContent><Notice tone="needs-you">The first limits could not be loaded. The member list and invitations above still work. Reload this page to check again.</Notice></CardContent>}
    {!unavailable&&(eligible.length>0||completed.length>0)&&<Rows label="First spending limits">
      {eligible.map(member=><Row key={`limit-${member.id}`} title={member.displayName}><MemberLimitForm member={member}/></Row>)}
      {completed.map(member=><Row key={`recorded-${member.id}`} title={member.displayName} description="A first limit is already recorded. It cannot be changed here."/>)}
    </Rows>}
    {!unavailable&&!eligible.length&&!completed.length&&<CardContent><p className="lares-muted">No active member who has signed in needs a first limit.</p></CardContent>}
  </Card>;
}
