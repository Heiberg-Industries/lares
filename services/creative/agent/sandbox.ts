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
// WHAT THIS SANDBOX IS, PLAINLY. just-bash is a JavaScript shell inside this process. It starts
// no container and no native process. eve's binding for it
// (`node_modules/eve/dist/src/execution/sandbox/bindings/just-bash-runtime.js`) creates the
// shell with `network: { dangerouslyAllowFullInternetAccess: true }` over a REAL read-write
// directory on disk (just-bash's `ReadWriteFs`, one directory per conversation under
// `.eve/sandbox-cache`), not an in-memory one. So a command run in it could write real files
// there and could reach any address this process can reach; nothing in the sandbox narrows
// that. The only limits are the ones around the process itself: the container's filesystem and
// its network.
//
// That is acceptable here ONLY because nothing runs a command in it. Every framework default
// tool is off (`defaultTools: false` in agent.ts), so the model has no tool that runs a command
// or reads or writes a file in the sandbox, and no agent code opens it. eve itself uses it to
// store attached files. Turning a sandbox tool on, or calling `ctx.getSandbox()` from agent
// code, is a decision about this file too.
import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

export const environment = JustBashSandbox.environment();
export default defineSandbox(() => environment.open());
