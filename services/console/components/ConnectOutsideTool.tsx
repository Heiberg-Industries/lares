"use client";
import { Choice, Field, FieldGroup, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Checkbox } from "@lares/ui/primitives/checkbox";
import { Input } from "@lares/ui/primitives/input";
import { Select } from "@lares/ui/primitives/select";
import { useRef, useState, type FormEvent } from "react";
import { connectActivateCredential, connectApplyAgent, connectDeclare, connectLookUpTools, connectRemoveDeclaration, connectReviewAndStage,
  type ConnectIdentity, type ConnectStep, type ConnectTool } from "../app/actions/outside-connect";
import type { OutsidePendingApplyDto } from "../lib/outside-discovery-dto";
import { suggestConnectionName, toolNamesOf } from "../lib/outside-connect-words";

type Agent = { name: string; displayName: string };
type Phase = "form" | "working" | "confirm" | "done";
type Row = { name: string; description?: string; inputSchema?: Record<string, unknown>; use: boolean; kind: "read" | "change" };
type Item = { label: string; status: "waiting" | "running" | "done" | "failed"; message?: string };
type Plan = { label: string; run: () => Promise<ConnectStep<unknown>> }[];
type Settings = { name: string; url: string; description: string; hasToken: boolean; trusted: boolean; agents: string[] };

/**
 * Connect any outside (MCP) tool server in two presses: Connect, then one confirmation of the tools it
 * offers. Behind them run the same steps the older pages ask for one by one. The token is kept only in
 * this page's memory while the owner reads the confirmation, is sent to the keeper (never to the agent),
 * and is dropped as soon as the work ends, fails for good or is cancelled.
 */
export function ConnectOutsideTool({ agents, initialAgent }: { agents: Agent[]; initialAgent?: string }) {
  const first = agents.find(a => a.name === initialAgent)?.name ?? agents[0]?.name;
  const [phase, setPhase] = useState<Phase>("form");
  const [url, setUrl] = useState(""), [token, setToken] = useState(""), [name, setName] = useState(""), [description, setDescription] = useState("");
  const [toolText, setToolText] = useState(""), [consent, setConsent] = useState(false), [trusted, setTrusted] = useState(false);
  const [ticked, setTicked] = useState<string[]>(first ? [first] : []);
  const [rows, setRows] = useState<Row[]>([]), [serverName, setServerName] = useState("");
  const [items, setItems] = useState<Item[]>([]), [failure, setFailure] = useState<{ message: string; retryable: boolean } | null>(null);
  const [error, setError] = useState(""), [cleanup, setCleanup] = useState("");
  const plan = useRef<Plan>([]), next = useRef(0), after = useRef<() => void>(() => {});
  const settings = useRef<Settings | null>(null), seen = useRef<ConnectTool[] | undefined>(undefined);

  const suggested = suggestConnectionName(url);
  const connectionName = (name.trim() || suggested);
  const needsToken = token.trim().length > 0;

  function reset() {
    setPhase("form"); setItems([]); setFailure(null); setRows([]); setError(""); setToken(""); setConsent(false); plan.current = []; next.current = 0; seen.current = undefined;
  }

  /** Runs the plan from `from`; stops at the first failure and says which step it was and why. */
  async function run(from: number) {
    setFailure(null); setCleanup("");
    for (let i = from; i < plan.current.length; i++) {
      next.current = i;
      setItems(list => list.map((item, k) => k === i ? { ...item, status: "running", message: undefined } : item));
      let result: ConnectStep<unknown>;
      try { result = await plan.current[i]!.run(); }
      catch { result = { ok: false, message: "The step did not return. Its result is not confirmed.", retryable: false }; }
      if (!result.ok) {
        setItems(list => list.map((item, k) => k === i ? { ...item, status: "failed", message: result.message } : item));
        setFailure({ message: result.message, retryable: result.retryable });
        if (!result.retryable) setToken("");
        return;
      }
      setItems(list => list.map((item, k) => k === i ? { ...item, status: "done" } : item));
    }
    after.current();
  }

  function start(steps: Plan, then: () => void) {
    plan.current = steps; next.current = 0; after.current = then;
    setItems(steps.map(s => ({ label: s.label, status: "waiting" }))); setPhase("working");
    void run(0);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const address = url.trim();
    if (!/^https?:\/\//i.test(address)) { setError("Paste the server's full address, starting with https://."); return; }
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(connectionName)) { setError("Give the connection a short name of lowercase letters, numbers and dashes."); return; }
    if (ticked.length === 0) { setError("Tick at least one agent."); return; }
    const chosen: Settings = { name: connectionName, url: address, description: description.trim() || `Tools from ${new URL(address).hostname}`,
      hasToken: needsToken, trusted, agents: ticked };
    settings.current = chosen;
    if (!needsToken) {
      const names = toolNamesOf(toolText);
      if (names.length === 0) { setError("This server needs no token, so Lares cannot ask it what it offers. Type the names of the tools you want the agent to use."); return; }
      setServerName(""); setRows(names.map(n => ({ name: n, use: true, kind: "change" }))); setPhase("confirm"); return;
    }
    if (!consent) { setError("Tick the box to allow sending the token to this address."); return; }
    const primary = chosen.agents[0]!;
    start([
      { label: `Save the connection on ${primary}`, run: () => connectDeclare({ agent: primary, provisional: true, connection: { name: chosen.name, url: chosen.url, description: chosen.description,
        token: true, trusted: false, allow: [], read: [] } }) },
      { label: "Ask the server which tools it offers", run: async () => {
        const result = await connectLookUpTools({ agent: primary, name: chosen.name, credential: token });
        if (result.ok) {
          seen.current = result.value.tools;
          setServerName(result.value.serverName);
          setRows(result.value.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, use: true, kind: "change" })));
        }
        return result;
      } },
    ], () => setPhase("confirm"));
  }

  function finish() {
    const chosen = settings.current!;
    const use = rows.filter(r => r.use);
    if (use.length === 0) { setError("Choose at least one tool for the agent to use."); return; }
    setError("");
    const connection = { name: chosen.name, url: chosen.url, description: chosen.description, token: chosen.hasToken, trusted,
      allow: use.map(r => r.name), read: use.filter(r => r.kind === "read").map(r => r.name) };
    const steps: Plan = [];
    for (const agent of chosen.agents) {
      if (!chosen.hasToken) { steps.push({ label: `Save the connection on ${agent} and apply it`, run: () => connectDeclare({ agent, provisional: false, connection }) }); continue; }
      let identity: ConnectIdentity | undefined, staged: OutsidePendingApplyDto | undefined;
      steps.push(
        { label: `Save the chosen tools on ${agent}`, run: () => connectDeclare({ agent, provisional: false, connection, applyNow: false }) },
        { label: `Ask the server again, to check ${agent} sees what you saw`, run: async () => {
          const r = await connectLookUpTools({ agent, name: chosen.name, credential: token }); if (r.ok) identity = r.value.identity; return r; } },
        { label: `Record and accept these exact descriptions for ${agent}`, run: async () => {
          if (!identity) return { ok: false as const, message: "The previous step has no result. Start again.", retryable: false };
          const r = await connectReviewAndStage({ identity, ...(seen.current ? { seen: seen.current } : {}) }); if (r.ok) staged = r.value; return r; } },
        { label: `Lock the token away for ${agent}`, run: async () => {
          if (!staged) return { ok: false as const, message: "The previous step has no result. Start again.", retryable: false };
          return connectActivateCredential({ staged }); } },
        { label: `Apply to ${agent}`, run: () => connectApplyAgent({ agent }) },
      );
    }
    start(steps, () => { setToken(""); setPhase("done"); });
  }

  async function cancelConfirmation() {
    const chosen = settings.current;
    // A token-less connection has saved nothing yet; a token connection has only its placeholder declaration to take back.
    if (chosen?.hasToken) { const gone = await connectRemoveDeclaration({ agent: chosen.agents[0]!, name: chosen.name }); if (!gone.ok) { setError(`The temporary connection could not be removed: ${gone.message}`); return; } }
    reset();
  }

  async function removeHalfDone() {
    const chosen = settings.current; if (!chosen) return;
    const lines: string[] = [];
    for (const agent of chosen.agents) {
      const r = await connectRemoveDeclaration({ agent, name: chosen.name });
      lines.push(r.ok ? `${agent}: ${r.value.removed ? "the half-set-up connection is removed" : "nothing to remove"}` : `${agent}: ${r.message}`);
    }
    setCleanup(`${lines.join(". ")}. A token already locked away stays locked away until you stop its use from the agent's page.`);
  }

  const working = phase === "working" && !failure && items.some(i => i.status === "running");
  return <section className="lares-stack" aria-label="Connect an outside tool">
    {phase === "form" && <form className="lares-stack" onSubmit={submit}>
      <Field label="Server address" hint="The MCP address the tool's maker gave you."><Input required type="url" maxLength={2048} value={url} onChange={e => setUrl(e.target.value)} /></Field>
      <Field label="Token (if the server needs one)" hint="Leave empty if the server asks for no login. The agent never sees the token; Lares keeps it locked away.">
        <Input type="password" autoComplete="off" maxLength={4096} value={token} onChange={e => setToken(e.target.value)} /></Field>
      <p className="lares-muted">Servers that use a sign-in page instead of a token will be connected here in a later version.</p>
      {!needsToken && <Field label="Tools the agent may use" hint="With no token Lares cannot ask the server for its tool list. Type the tool names, separated by commas."><Input value={toolText} onChange={e => setToolText(e.target.value)} /></Field>}
      <Field label="Name" hint="Short, lowercase. Used as a prefix on the tool names."><Input maxLength={31} placeholder={suggested} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="What it is for (optional)"><Input maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></Field>
      <FieldGroup legend="Agents that get these tools">
        {agents.map(agent => <Choice key={agent.name}><Checkbox checked={ticked.includes(agent.name)}
          onChange={e => setTicked(list => e.target.checked ? [...list, agent.name] : list.filter(n => n !== agent.name))} /> {agent.displayName}</Choice>)}
      </FieldGroup>
      {needsToken && <Choice><Checkbox checked={consent} onChange={e => setConsent(e.target.checked)} /> I allow Lares to send this token to the address above, up to once per agent plus once to read the tool list.</Choice>}
      {error && <p role="alert">{error}</p>}
      <div className="lares-actions"><Button type="submit">Connect</Button></div>
    </form>}

    {phase === "working" && <Progress items={items} />}
    {phase === "working" && working && <p role="status">Working. This can take a minute while the agent restarts.</p>}
    {phase === "working" && failure && <div className="lares-stack">
      <Notice>Not connected yet. {failure.message}</Notice>
      <div className="lares-actions">
        {failure.retryable && <Button type="button" onClick={() => void run(next.current)}>Try again</Button>}
        <Button type="button" variant="outline" onClick={() => { reset(); }}>Start over</Button>
        <Button type="button" variant="outline" onClick={() => void removeHalfDone()}>Remove the half-set-up connection</Button>
      </div>
      {cleanup && <p role="status">{cleanup}</p>}
    </div>}

    {phase === "confirm" && <div className="lares-stack">
      <h2 className="lares-section-title">{serverName ? `${serverName} offers ${rows.length} tool${rows.length === 1 ? "" : "s"}` : "Tools you chose"}</h2>
      <p>Pick the tools the agent may use, and say whether each only looks things up or changes something. Until you say otherwise, every call asks you first. If the server later changes a tool's description, that tool stops until you review it again.</p>
      {!serverName && <p>Lares has not seen these tools yet. Their descriptions are recorded the first time the agent connects, and a later change pauses the tool.</p>}
      <ul className="lares-data-list">{rows.map((row, i) => <li key={row.name} className="lares-stack">
        <Choice><Checkbox checked={row.use} onChange={e => setRows(list => list.map((r, k) => k === i ? { ...r, use: e.target.checked } : r))} /> <strong>{row.name}</strong></Choice>
        {row.description && <p>{row.description}</p>}
        <Select aria-label={`What ${row.name} does`} value={row.kind} disabled={!row.use} onChange={e => setRows(list => list.map((r, k) => k === i ? { ...r, kind: e.target.value as Row["kind"] } : r))}>
          <option value="change">Changes something</option><option value="read">Only looks things up</option>
        </Select>
        {row.inputSchema && <details><summary>What it asks for</summary><pre>{JSON.stringify(row.inputSchema, null, 2)}</pre></details>}
      </li>)}</ul>
      <Choice><Checkbox checked={trusted} onChange={e => setTrusted(e.target.checked)} /> Let look-ups run without asking (off is safest; applies to every tool marked “only looks things up”)</Choice>
      {error && <p role="alert">{error}</p>}
      <div className="lares-actions"><Button type="button" onClick={finish}>Connect</Button><Button type="button" variant="outline" onClick={() => void cancelConfirmation()}>Cancel</Button></div>
    </div>}

    {phase === "done" && <div className="lares-stack">
      <Progress items={items} />
      <Notice>Connected. {settings.current?.agents.join(", ")} can now use {rows.filter(r => r.use).length} tool{rows.filter(r => r.use).length === 1 ? "" : "s"} from {serverName || settings.current?.name}. Every call still asks you first. This does not yet prove the server answers: ask the agent to look something up to try it.</Notice>
      <div className="lares-actions"><Button type="button" variant="outline" onClick={reset}>Connect another</Button></div>
    </div>}
  </section>;
}

function Progress({ items }: { items: Item[] }) {
  const mark = { waiting: "○", running: "…", done: "✓", failed: "✗" } as const;
  return <ol className="lares-stack" aria-label="Progress">{items.map((item, i) => <li key={i} data-status={item.status}>
    <span aria-hidden="true">{mark[item.status]}</span> {item.label}{item.message && <> — <span role="alert">{item.message}</span></>}
  </li>)}</ol>;
}
