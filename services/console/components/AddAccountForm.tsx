"use client";
import { Select } from "@lares/ui/primitives/select";
import { Field } from "@lares/ui/patterns";

export function PersonalConsentPowerSelect() {
  return <Field label="Provider permissions">
    <Select name="power" defaultValue="read">
      <option value="read">Read mailbox and calendar</option>
      <option value="read+mail-draft">Read mailbox, calendar and Drive files, write drafts, and add or change calendar events (each one approved by you)</option>
      <option value="read+mail-send">Read mailbox and calendar, and allow mail sending</option>
    </Select>
  </Field>;
}
