"use client";
import { useActionState } from "react";
import { Choice, FieldGroup, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Radio } from "@lares/ui/primitives/checkbox";
import { setMemberRole, type RoleResult } from "../app/actions/members";
import { PICKER_ROLES, ROLE_WORDS, type PickerRole } from "../lib/member-roles";

/** Admin or Member for one person, with one line saying what each means. It sits under the person's
 *  name, in the row's own column, so the buttons on the right keep their room on a narrow screen.
 *  Only the owner is shown this, and the action behind it checks that again. */
export function MemberRolePicker({ memberId, displayName, role }: { memberId: string; displayName: string; role: PickerRole }) {
  const [state, action, pending] = useActionState<RoleResult, FormData>(setMemberRole, {});
  return <form action={action} className="lares-stack">
    <input type="hidden" name="memberId" value={memberId} />
    <FieldGroup legend={`Role for ${displayName}`}>
      {PICKER_ROLES.map(option => <Choice key={option}>
        <Radio name="role" value={option} defaultChecked={option === role} />
        <span><strong>{ROLE_WORDS[option]!.name}.</strong> {ROLE_WORDS[option]!.meaning}</span>
      </Choice>)}
    </FieldGroup>
    <div className="lares-actions">
      <Button type="submit" variant="outline" size="sm" disabled={pending}>{pending ? "Saving…" : "Save role"}</Button>
    </div>
    {state.error && <Notice error>{state.error}</Notice>}
    {state.saved && <Notice tone="success">Role saved. It applies the next time this person opens a page.</Notice>}
  </form>;
}
