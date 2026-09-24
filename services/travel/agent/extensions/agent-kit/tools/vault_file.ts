// This mounted copy of the kit's note tool stays OFF in this role, unconditionally. The kit's
// mounted note tools carry no per-session authority, so they can open no Vault area at all
// (fail closed); a role that holds a note area reaches it through its own catalogue tools, which
// do carry that authority. It used to resolve against a capability called "brain", which no
// longer exists — that check was false for ever, so this is the same behaviour, said plainly.
import { disableTool } from "eve/tools";

export default disableTool();
