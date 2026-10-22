import { defineDynamic, defineSkill } from "eve/skills";
import { publicDocsIndex } from "@lares/agent-kit/public-docs-runtime";
import { verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";

const markdown = `# Public Lares documentation

Use this only for public Lares product, installation, and console guidance. The pages are fixed to the reviewed release corpus; they do not describe a particular installation or reveal private state.

To answer from a page, call the lares_read_public_doc tool with exactly one listed ID. Do not guess IDs or URLs. If the baked page cannot be verified or read, say that the public guidance is unavailable and answer only from information already provided.

${publicDocsIndex()}
`;

export default defineDynamic({ events: { "session.started": async (_event, ctx) => {
  await verifyPrivateConsoleSession(ctx);
  return defineSkill({
    description: "Use when asked about Lares installation, product setup, the console, or the reviewed public help pages.",
    markdown,
  });
} } });
