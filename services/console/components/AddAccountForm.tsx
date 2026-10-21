"use client";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";

export function PersonalConsentPowerSelect() {
  return <label className="lares-field-label">Provider permissions
    <select name="power" defaultValue="read">
      <option value="read">Read mailbox and calendar</option>
      <option value="read+mail-send">Read mailbox and calendar, and allow mail sending</option>
    </select>
  </label>;
}

export function AddAccountForm() {
  return (
    <form method="POST" action="/api/accounts/google/start" className="lares-inline-form lares-operational-filter">
      <input type="hidden" name="intent" value="new" />
      <label className="lares-field-label" htmlFor="connection-email">
        Connect a Google account
      </label>
      <Input
        id="connection-email"
        name="email"
        type="email"
        required
        placeholder="name@domain.com"
      />
      <PersonalConsentPowerSelect />
      <Button type="submit">
        Connect
      </Button>
    </form>
  );
}
