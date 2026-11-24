"use client";
import { Choice, Field, FieldGroup, Notice, ToolList, ToolRow } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Checkbox } from "@lares/ui/primitives/checkbox";
import { Input } from "@lares/ui/primitives/input";
import { Select } from "@lares/ui/primitives/select";
import { Switch } from "@lares/ui/primitives/switch";
import { SECRET_AS_NAME_MESSAGE, looksLikeSecret } from "@lares/agent-kit/secret-shaped";
import { useRef, useState, type FormEvent } from "react";
import { connectActivateCredential, connectApplyAgent, connectDeclare, connectLookUpTools, connectRemoveDeclaration, connectReviewAndStage, connectSwitchOnTrust,
  type ConnectDeclared, type ConnectIdentity, type ConnectStep, type ConnectTool } from "../app/actions/outside-connect";
import type { OutsidePendingApplyDto } from "../lib/outside-discovery-dto";
import { suggestConnectionName, toolNamesOf, uniqueConnectionName } from "../lib/outside-connect-words";
import { readOnlyChoiceWords, whereToolsWork } from "../lib/outside-tools-words";

type Agent = { name: string; displayName: string };
type Phase = "form" | "working" | "confirm" | "done";
type Row = { name: string; description?: string; inputSchema?: Record<string, unknown>; use: boolean; kind: "read" | "change"; free: boolean; seen: boolean };
type Item = { label: string; status: "waiting" | "running" | "done" | "failed"; message?: string };
type Plan = { label: string; run: () => Promise<ConnectStep<unknown>> }[];
type Settings = { name: string; url: string; description: string; hasToken: boolean; agents: string[] };
/** A tool that changes something, on an agent whose outside access is read-only: the save left it out and waits for the owner's answer. */
type ReadOnlyConflict = { agent: string; tools: string[]; confirming: boolean };

/**
 * Connect any outside (MCP) tool server in two presses: Connect, then one confirmation of the tools it
 * offers. Behind them run the same steps the older pages ask for one by one. The token is kept only in
 * this page's memory while the owner reads the confirmation, is sent to the keeper (never to the agent),
 * and is dropped as soon as the work ends, fails for good or is cancelled.
 */
export function ConnectOutsideTool({ agents, initialAgent, takenNames = [] }: { agents: Agent[]; initialAgent?: string; takenNames?: string[] }) {
  const first = agents.find(a => a.name === initialAgent)?.name ?? agents[0]?.name;
  const [phase, setPhase] = useState<Phase>("form");
  const [url, setUrl] = useState(""), [token, setToken] = useState(""), [name, setName] = useState(""), [description, setDescription] = useState("");
  const [toolText, setToolText] = useState(""), [consent, setConsent] = useState(false);
  const [ticked, setTicked] = useState<string[]>(first ? [first] : []);
  const [rows, setRows] = useState<Row[]>([]), [serverName, setServerName] = useState("");
  const [items, setItems] = useState<Item[]>([]), [failure, setFailure] = useState<{ message: string; retryable: boolean } | null>(null);
  const [error, setError] = useState(""), [cleanup, setCleanup] = useState(""), [switchResult, setSwitchResult] = useState(""), [dropped, setDropped] = useState<string[]>([]);
  const [conflict, setConflict] = useState<ReadOnlyConflict | null>(null), [leftOut, setLeftOut] = useState<string[]>([]), [askFirst, setAskFirst] = useState<string[]>([]), [switchNotes, setSwitchNotes] = useState<{ ok: boolean; text: string }[]>([]);
  const answer = useRef<(a: "leave" | "ask") => void>(() => {});
  const plan = useRef<Plan>([]), next = useRef(0), after = useRef<() => void>(() => {});
  const settings = useRef<Settings | null>(null), seen = useRef<ConnectTool[] | undefined>(undefined);
  // What the agent already had for this connection: a reconnect shows those switches as they are.
  const prior = useRef<{ trusted: string[]; tools: string[] }>({ trusted: [], tools: [] });

  const suggested = uniqueConnectionName(suggestConnectionName(url), takenNames);
  const connectionName = (name.trim() || suggested);
  const needsToken = token.trim().length > 0;

  function reset() {
    setPhase("form"); setItems([]); setFailure(null); setRows([]); setError(""); setToken(""); setConsent(false); plan.current = []; next.current = 0; seen.current = undefined; prior.current = { trusted: [], tools: [] }; setDropped([]); setConflict(null); setLeftOut([]); setAskFirst([]); setSwitchNotes([]);
  }

  /** Stops the work on one agent until the owner says what to do with tools that change something and cannot be allowed by its read-only access. */
  function ask(agent: string, tools: string[]): Promise<"leave" | "ask"> {
    return new Promise(resolve => {
      answer.current = a => { setConflict(null); resolve(a); };
      setConflict({ agent, tools, confirming: false });
    });
  }

  /** One save of the chosen tools on one agent. A conflict does not fail it: the rest is saved, then the owner chooses per agent. */
  async function declareWithChoice(agent: string, connection: { name: string; url: string; description: string; token: boolean; allow: string[]; read: string[] }, applyNow: boolean): Promise<ConnectStep<ConnectDeclared>> {
    let r = await connectDeclare({ agent, provisional: false, connection, ...(applyNow ? {} : { applyNow: false }) });
    if (r.ok && r.value.conflicts.length) {
      const tools = r.value.conflicts;
      if (await ask(agent, tools) === "ask") {
        r = await connectDeclare({ agent, provisional: false, connection, widen: true, ...(applyNow ? {} : { applyNow: false }) });
        if (r.ok) setAskFirst(list => [...list, ...tools.map(t => `${t} (${agent})`)]);
      } else setLeftOut(list => [...list, ...tools.map(t => `${t} (${agent})`)]);
    }
    return r;
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
      hasToken: needsToken, agents: ticked };
    settings.current = chosen;
    if (!needsToken) {
      const names = toolNamesOf(toolText);
      if (names.length === 0) { setError("This server needs no token, so Lares cannot ask it what it offers. Type the names of the tools you want the agent to use."); return; }
      if (names.some(looksLikeSecret)) { setError(SECRET_AS_NAME_MESSAGE); return; }
      setServerName(""); setRows(names.map(n => ({ name: n, use: true, kind: "change", free: false, seen: false }))); setPhase("confirm"); return;
    }
    if (!consent) { setError("Tick the box to allow sending the token to this address."); return; }
    const primary = chosen.agents[0]!;
    start([
      { label: `Save the connection on ${primary}`, run: async () => {
        const r = await connectDeclare({ agent: primary, provisional: true, connection: { name: chosen.name, url: chosen.url, description: chosen.description, token: true, allow: [], read: [] } });
        if (r.ok) prior.current = { trusted: r.value.currentTrusted, tools: r.value.previousTools };
        return r;
      } },
      { label: "Ask the server which tools it offers", run: async () => {
        const result = await connectLookUpTools({ agent: primary, name: chosen.name, credential: token });
        if (result.ok) {
          seen.current = result.value.tools;
          setServerName(result.value.serverName);
          setRows(result.value.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, use: true, kind: t.readOnly ? "read" : "change", seen: true,
            free: prior.current.tools.includes(t.name) ? prior.current.trusted.includes(t.name) : t.readOnly === true })));
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
    const connection = { name: chosen.name, url: chosen.url, description: chosen.description, token: chosen.hasToken,
      allow: use.map(r => r.name), read: use.filter(r => r.kind === "read").map(r => r.name),
    };
    const steps: Plan = [];
    for (const agent of chosen.agents) {
      if (!chosen.hasToken) { steps.push({ label: `Save the connection on ${agent} and apply it`, run: () => declareWithChoice(agent, connection, true) }); continue; }
      let identity: ConnectIdentity | undefined, staged: OutsidePendingApplyDto | undefined;
      steps.push(
        { label: `Save the chosen tools on ${agent}`, run: async () => {
          const r = await declareWithChoice(agent, connection, false);
          if (r.ok && r.value.droppedTrust.length) setDropped(list => [...list, ...r.value.droppedTrust.map(t => `${t} (${agent})`)]);
          return r;
        } },
        { label: `Ask the server again, to check ${agent} sees what you saw`, run: async () => {
          const r = await connectLookUpTools({ agent, name: chosen.name, credential: token }); if (r.ok) identity = r.value.identity; return r; } },
        { label: `Record and accept these exact descriptions for ${agent}`, run: async () => {
          if (!identity) return { ok: false as const, message: "The previous step has no result. Start again.", retryable: false };
          const r = await connectReviewAndStage({ identity, ...(seen.current ? { seen: seen.current } : {}) }); if (r.ok) staged = r.value; return r; } },
        { label: `Lock the token away for ${agent}`, run: async () => {
          if (!staged) return { ok: false as const, message: "The previous step has no result. Start again.", retryable: false };
          return connectActivateCredential({ staged }); } },
        // The look-up tools the server marks read-only run without asking from the first conversation, as the owner's own recorded choice (the
        // owner could untick any of them above). The accepted descriptions are already the pin, so no earlier conversation is needed. If
        // this cannot be done (for example the member may not approve this agent's outside calls) the connection still goes ahead, and asks.
        { label: `Let ${agent} run the look-up tools without asking`, run: async () => {
          const names = desiredFree();
          const r = await connectSwitchOnTrust({ agent, name: chosen.name, tools: names });
          setSwitchNotes(list => [...list, { ok: r.ok, text: r.ok ? `${agent}: ${r.value.switchedOn.length ? `${r.value.switchedOn.join(", ")} run without asking` : "nothing new runs without asking"}` : `${agent}: ${r.message}` }]);
          return { ok: true as const, value: null };
        } },
        { label: `Apply to ${agent}`, run: () => connectApplyAgent({ agent }) },
      );
    }
    start(steps, () => { setToken(""); setPhase("done"); });
  }

  const desiredFree = () => rows.filter(r => r.use && r.kind === "read" && r.free && r.seen).map(r => r.name);

  /** After connecting. The keeper takes each tool's fingerprint from the description the agent has stored, so this works once the agent has read the tool list. */
  async function switchOn() {
    const chosen = settings.current; if (!chosen) return;
    const names = desiredFree();
    const lines: string[] = [];
    for (const agent of chosen.agents) {
      const r = await connectSwitchOnTrust({ agent, name: chosen.name, tools: names });
      lines.push(r.ok ? `${agent}: switched on ${r.value.switchedOn.length ? r.value.switchedOn.join(", ") : "nothing new"}${r.value.switchedOff.length ? `; switched off ${r.value.switchedOff.join(", ")}` : ""}` : `${agent}: ${r.message}`);
    }
    setSwitchResult(lines.join(". "));
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
      {!needsToken && <Field label="Tools the agent may use" hint="With no token Lares cannot ask the server for its tool list. Type the tool names, separated by commas. A key or password goes in the Token field above, never here."><Input value={toolText} onChange={e => setToolText(e.target.value)} /></Field>}
      <FieldGroup legend="Agents that get these tools">
        {agents.map(agent => <Choice key={agent.name}><Checkbox checked={ticked.includes(agent.name)}
          onChange={e => setTicked(list => e.target.checked ? [...list, agent.name] : list.filter(n => n !== agent.name))} /> {agent.displayName}</Choice>)}
      </FieldGroup>
      <details>
        <summary>More options</summary>
        <div className="lares-stack">
          <Field label="Name" hint="Short, lowercase. Used as a prefix on the tool names. Filled in from the address."><Input maxLength={31} placeholder={suggested} value={name} onChange={e => setName(e.target.value)} /></Field>
          <Field label="What it is for (optional)"><Input maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></Field>
        </div>
      </details>
      {needsToken && <Choice><Checkbox checked={consent} onChange={e => setConsent(e.target.checked)} /> I allow Lares to send this token to the address above, up to once per agent plus once to read the tool list.</Choice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="lares-actions"><Button type="submit">Connect</Button></div>
    </form>}

    {phase === "working" && <Progress items={items} />}
    {phase === "working" && conflict && <div className="lares-stack">
      <Notice tone="needs-you">{readOnlyChoiceWords(agents.find(a => a.name === conflict.agent)?.displayName ?? conflict.agent, conflict.tools)}</Notice>
      <div className="lares-actions">
        {!conflict.confirming && <>
          <Button type="button" variant="outline" onClick={() => answer.current("leave")}>Leave it out</Button>
          <Button type="button" onClick={() => setConflict({ ...conflict, confirming: true })}>Let {agents.find(a => a.name === conflict.agent)?.displayName ?? conflict.agent} ask first</Button>
        </>}
        {conflict.confirming && <>
          <p>This widens {agents.find(a => a.name === conflict.agent)?.displayName ?? conflict.agent}&apos;s outside access so it may use tools that change something, always after asking you. It applies to every outside tool of this agent.</p>
          <Button type="button" onClick={() => answer.current("ask")}>Yes, let it ask first</Button>
          <Button type="button" variant="outline" onClick={() => setConflict({ ...conflict, confirming: false })}>Back</Button>
        </>}
      </div>
    </div>}
    {phase === "working" && working && !conflict && <Notice tone="working">Working. This can take a minute while the agent restarts.</Notice>}
    {phase === "working" && failure && <div className="lares-stack">
      <Notice tone="error">Not connected yet. {failure.message}</Notice>
      <div className="lares-actions">
        {failure.retryable && <Button type="button" onClick={() => void run(next.current)}>Try again</Button>}
        <Button type="button" variant="outline" onClick={() => { reset(); }}>Start over</Button>
        <Button type="button" variant="outline" onClick={() => void removeHalfDone()}>Remove the half-set-up connection</Button>
      </div>
      {cleanup && <Notice>{cleanup}</Notice>}
    </div>}

    {phase === "confirm" && <div className="lares-stack">
      <h2 className="lares-section-title">{serverName ? `${serverName} offers ${rows.length} tool${rows.length === 1 ? "" : "s"}` : "Tools you chose"}</h2>
      <p>Pick the tools the agent may use, and say whether each only looks things up or changes something. Tools the server itself marks as read-only start as “only looks things up” and with “Run without asking” ticked; the rest start as “changes something” and always ask you first. Untick any of them before you connect. Lares switches the ticked ones on in this same connect, with no conversation needed first, and records it as your own decision with the time. You can change it later on the connection's page. A tool that changes something can never run without asking. If the server later changes a tool's description, that tool stops until you review it again.</p>
      {!serverName && <Notice>Lares has not seen these tools yet. Their descriptions are recorded the first time the agent connects, and a later change pauses the tool.</Notice>}
      <ToolList label="Tools to connect">{rows.map((row, i) => <ToolRow key={row.name} name={row.name} kind={row.kind} description={row.description}
        control={<Switch aria-label={row.name} checked={row.use} onCheckedChange={on => setRows(list => list.map((r, k) => k === i ? { ...r, use: on } : r))} />}>
        <Select aria-label={`What ${row.name} does`} value={row.kind} disabled={!row.use} onChange={e => setRows(list => list.map((r, k) => k === i ? { ...r, kind: e.target.value as Row["kind"], free: e.target.value === "read" ? r.free : false } : r))}>
          <option value="change">Changes something</option><option value="read">Only looks things up</option>
        </Select>
        {row.seen && <Choice><Checkbox checked={row.free && row.kind === "read"} disabled={!row.use || row.kind !== "read"}
          onChange={e => setRows(list => list.map((r, k) => k === i ? { ...r, free: e.target.checked } : r))} /> Run without asking{row.free && row.kind === "read" ? " — the server says this only looks things up" : ""}</Choice>}
        {row.inputSchema && <details><summary>What it asks for</summary><pre>{JSON.stringify(row.inputSchema, null, 2)}</pre></details>}
      </ToolRow>)}</ToolList>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="lares-actions"><Button type="button" onClick={finish}>Connect</Button><Button type="button" variant="outline" onClick={() => void cancelConfirmation()}>Cancel</Button></div>
    </div>}

    {phase === "done" && <div className="lares-stack">
      <Progress items={items} />
      <Notice tone="success">Connected. {settings.current?.agents.join(", ")} can now use {rows.filter(r => r.use).length - leftOut.length} tool{rows.filter(r => r.use).length - leftOut.length === 1 ? "" : "s"} from {serverName || settings.current?.name}. Tools you did not switch on to run without asking still ask you first. This does not yet prove the server answers: ask the agent to look something up to try it.</Notice>
      <p>{whereToolsWork(rows.filter(r => r.use).length - leftOut.length, desiredFree().length)}</p>
      {switchNotes.length > 0 && <Notice tone={switchNotes.every(n => n.ok) ? "info" : "needs-you"}>Run without asking: {switchNotes.map(n => n.text).join(". ")}.</Notice>}
      {leftOut.length > 0 && <Notice tone="info">Left out because the agent&apos;s outside access is read-only: {leftOut.join(", ")}.</Notice>}
      {askFirst.length > 0 && <Notice tone="info">These tools may now be used, always after asking you first: {askFirst.join(", ")}.</Notice>}
      {dropped.length > 0 && <Notice tone="needs-you">Run without asking was switched off for {dropped.join(", ")} because the tool changed since you switched it on. You can switch it on again below.</Notice>}
      {(dropped.length > 0 || switchNotes.some(n => !n.ok)) && desiredFree().length > 0 && <div className="lares-stack">
        <div className="lares-actions"><Button type="button" onClick={() => void switchOn()}>Switch on Run without asking</Button></div>
        {switchResult && <Notice>{switchResult}</Notice>}
      </div>}
      <div className="lares-actions"><Button type="button" variant="outline" onClick={reset}>Connect another</Button></div>
    </div>}
  </section>;
}

const STEP_TONE = { waiting: "info", running: "working", done: "success", failed: "error" } as const;

function Progress({ items }: { items: Item[] }) {
  return <ol className="lares-stack" aria-label="Progress">{items.map((item, i) => <li key={i} data-status={item.status}>
    <Notice tone={STEP_TONE[item.status]}>{item.label}{item.message && <> — {item.message}</>}</Notice>
  </li>)}</ol>;
}
