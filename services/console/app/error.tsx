"use client";
import { Button } from "@lares/ui/primitives/button";
import { PageHeader, Notice } from "@lares/ui/patterns";
export default function ConsoleError({ reset }: { reset: () => void }) {
  return (
    <div className="lares-page">
      <PageHeader title="This page is unavailable" />
      <Notice error>
        We could not read the current state. Try again before making another change.
      </Notice>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
