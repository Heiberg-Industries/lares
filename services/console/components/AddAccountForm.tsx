"use client";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { Select } from "@lares/ui/primitives/select";
import { Field } from "@lares/ui/patterns";

export function PersonalConsentPowerSelect() {
  return <Field label="Provider permissions">
    <Select name="power" defaultValue="read">
      <option value="read">Read mailbox and calendar</option>
      <option value="read+mail-send">Read mailbox and calendar, and allow mail sending</option>
    </Select>
  </Field>;
}

export function AddAccountForm() {
  return (
    <form method="POST" action="/api/accounts/google/start" className="lares-inline-form lares-operational-filter">
      <input type="hidden" name="intent" value="new" />
      <Field label="Connect a Google account">
        <Input
          id="connection-email"
          name="email"
          type="email"
          required
          placeholder="name@domain.com"
        />
      </Field>
      <PersonalConsentPowerSelect />
      <Button type="submit">
        Connect
      </Button>
    </form>
  );
}
