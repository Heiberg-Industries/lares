import { Notice, Page } from "@lares/ui/patterns";
export default function Loading() {
  return (
    <Page>
      <Notice tone="working">Reading the current state…</Notice>
    </Page>
  );
}
