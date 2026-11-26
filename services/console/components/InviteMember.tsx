"use client";
import { useActionState } from "react";
import { Field, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
import { Select } from "@lares/ui/primitives/select";
import { createInvitation, type InviteResult } from "../app/actions/members";
import { ROLE_WORDS } from "../lib/member-roles";
/** The roles an invitation can carry, in the order the form offers them. */
const INVITE_ROLES = ["member", "restricted", "owner"] as const;
export function InviteMember() {
  const [state, action, pending] = useActionState<InviteResult, FormData>(createInvitation, {});
  return <Card>
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>Invite a member</CardTitle>
      <CardDescription>Give the invitation link to the person privately. Whoever opens it first becomes this member, so do not post it where others can see it. It works once and stops working after 24 hours.</CardDescription>
    </CardHeader>
    <CardContent className="lares-stack">
      <form action={action} className="lares-stack">
        <Field label="Name"><Input name="displayName" required maxLength={200} /></Field>
        <Field label="Email for the member record"><Input name="email" type="email" required maxLength={254} /></Field>
        <Field label="Role" hint={INVITE_ROLES.map(role => `${ROLE_WORDS[role]!.name}: ${ROLE_WORDS[role]!.meaning}`).join(" ")}>
          <Select name="role" defaultValue="member">{INVITE_ROLES.map(role => <option key={role} value={role}>{ROLE_WORDS[role]!.name}</option>)}</Select>
        </Field>
        <Button type="submit" disabled={pending}>{pending ? "Creating invitation…" : "Create invitation"}</Button>
      </form>
      {state.error && <Notice error>{state.error}</Notice>}
      {state.url && <Notice tone="success">
        <p>Copy this link now. It will not be shown again after you leave.</p>
        <Input aria-label="Invitation link" readOnly value={state.url} onFocus={event => event.target.select()} />
      </Notice>}
    </CardContent>
  </Card>;
}
