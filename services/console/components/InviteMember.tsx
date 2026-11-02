"use client";
import { useActionState } from "react";
import { Field, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { Select } from "@lares/ui/primitives/select";
import { createInvitation, type InviteResult } from "../app/actions/members";
export function InviteMember() {
  const [state, action, pending] = useActionState<InviteResult, FormData>(createInvitation, {});
  return <section className="lares-surface lares-stack"><h2 className="lares-section-title">Invite a member</h2>
    <p>Share the invitation link with the intended person privately. Anyone holding it can bind their sign-in identity to this invitation. It expires in 24 hours and works once.</p>
    <form action={action} className="lares-stack">
      <Field label="Name"><Input name="displayName" required maxLength={200} /></Field>
      <Field label="Email for the member record"><Input name="email" type="email" required maxLength={254} /></Field>
      <Field label="Role"><Select name="role" defaultValue="member"><option value="member">Member</option><option value="restricted">Restricted</option><option value="owner">Owner</option></Select></Field>
      <Button type="submit" disabled={pending}>{pending ? "Creating invitation…" : "Create invitation"}</Button>
    </form>
    {state.error && <Notice error>{state.error}</Notice>}
    {state.url && <div role="status" className="lares-stack"><p>Copy this link now. It will not be shown again after you leave.</p><Input aria-label="Invitation link" readOnly value={state.url} onFocus={event => event.target.select()} /></div>}
  </section>;
}
