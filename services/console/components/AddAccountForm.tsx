"use client";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";

export function AddAccountForm() {
  return (
    <form method="POST" action="/api/accounts/google/start" className="lares-inline-form lares-operational-filter">
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
      <Button type="submit">
        Connect
      </Button>
    </form>
  );
}
