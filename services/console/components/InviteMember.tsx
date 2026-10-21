"use client";
import { useActionState } from "react";
import { createInvitation, type InviteResult } from "../app/actions/members";
export function InviteMember() {
  const [state, action, pending] = useActionState<InviteResult, FormData>(createInvitation, {});
  return <section className="lares-surface lares-stack"><h2 className="lares-section-title">Invite a member</h2>
    <p>Share the invitation link with the intended person privately. Anyone holding it can bind their sign-in identity to this invitation. It expires in 24 hours and works once.</p>
    <form action={action} className="lares-stack">
      <label>Name <input name="displayName" required maxLength={200} /></label>
      <label>Email for the member record <input name="email" type="email" required maxLength={254} /></label>
      <label>Role <select name="role" defaultValue="member"><option value="member">Member</option><option value="restricted">Restricted</option><option value="owner">Owner</option></select></label>
      <button type="submit" disabled={pending}>{pending ? "Creating invitation…" : "Create invitation"}</button>
    </form>
    {state.error && <p role="alert">{state.error}</p>}
    {state.url && <div role="status"><p>Copy this link now. It will not be shown again after you leave.</p><input aria-label="Invitation link" readOnly value={state.url} onFocus={event => event.target.select()} /></div>}
  </section>;
}
