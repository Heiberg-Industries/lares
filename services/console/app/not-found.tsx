import Link from "next/link";
import { PageHeader } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
export default function NotFound() {
  return (
    <div className="lares-page">
      <PageHeader
        title="Page not found"
        description="This agent or page is not available at this address."
      />
      <Button variant="outline" asChild>
        <Link href="/agents">Back to agents</Link>
      </Button>
    </div>
  );
}
