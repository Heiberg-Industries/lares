import { requireConsolePage } from "../../../lib/auth";
import Link from "next/link";
import { getCatalogue } from "../../../lib/signals";
import { JsonEditor } from "../../../components/JsonEditor";
import { saveCatalogue } from "../../actions/signals";
import { Notice, PageHeader, Page } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
export const dynamic = "force-dynamic";
export default async function CataloguePage() {
  await requireConsolePage();
  const r = await getCatalogue();
  return (
    <Page>
      <PageHeader
        title="Alert catalogue"
        description="The plain sentence shown with each kind of alert: what it means and what to do next."
        actions={
          <Button variant="outline" asChild>
            <Link href="/alert-routing">← Alert routing</Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>Advanced</CardTitle>
          <CardDescription>
            The catalogue is written as a list in a code-like format. Change it only if you are comfortable editing it; a mistake is refused when you save, and nothing changes until a save succeeds.
          </CardDescription>
        </CardHeader>
        <CardContent className="lares-stack">
          {"unavailable" in r ? (
            <Notice error>
              The catalogue could not be loaded because the service that records alerts did not answer. Check that it is running on your server, then reload this page.
            </Notice>
          ) : (
            <JsonEditor
              label="Catalogue"
              initial={r.catalogue}
              onSave={saveCatalogue}
              hint="One entry per source, type and key, with one plain sentence: what it means for a person and the next step. An empty key is the fallback for that source and type. Your entries win over the built-in ones."
            />
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
