// Selects eve's in-process sandbox by name, so the choice does not depend on where the image
// is built.
//
// With no sandbox file eve chooses a provider while it builds: Vercel when it runs there, Docker
// when a daemon answers, and for a production `eve build` with neither, NONE
// (`node_modules/eve/docs/sandbox/default.mdx`, "How eve selects the provider"). Images are built
// in CI with neither, so the build would record no sandbox at all and the first conversation
// that opened one would fail. The sandbox is where eve keeps a file somebody attaches to a
// message: without one, an attachment reaches the agent as "could not be stored" before any
// agent code sees it.
//
// just-bash is a JavaScript shell over a virtual filesystem inside this process. It starts no
// container and no native process, and it has no network isolation of its own. That is
// acceptable here ONLY because the agent has no tool that reaches it: every framework default
// tool is off (`defaultTools: false` in agent.ts), so nothing the model can call runs a command
// or reads a file in it. Turning a sandbox tool on is a decision about this file too.
import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

export const environment = JustBashSandbox.environment();
export default defineSandbox(() => environment.open());
