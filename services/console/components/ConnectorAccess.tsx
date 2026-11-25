"use client";
import { Choice, Field, FieldGroup, Notice, ToolList, ToolRow } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Checkbox } from "@lares/ui/primitives/checkbox";
import { Input } from "@lares/ui/primitives/input";
import { Switch } from "@lares/ui/primitives/switch";
import { SECRET_AS_NAME_MESSAGE, looksLikeSecret } from "@lares/agent-kit/secret-shaped";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { connectActivateCredential, connectApplyAgent, connectDeclare, connectLookUpTools, connectReviewAndStage, connectSetTools, connectSwitchOnTrust,
  type ConnectIdentity, type ConnectStep, type ConnectTool } from "../app/actions/outside-connect";
import { removeFromAgent } from "../app/actions/outside-connectors";
import type { OutsidePendingApplyDto } from "../lib/outside-discovery-dto";
import { toolNamesOf } from "../lib/outside-connect-words";
import { readOnlyChoiceWords, whereToolsWork } from "../lib/outside-tools-words";
import type { AgentUse } from "../lib/outside-connector-view";

type Agent = { name: string; displayName: string };
type Conn = { slug: string; url: string; description: string; authKind: "none" | "token" | "signin" };
type Plan = { label: string; run: () => Promise<ConnectStep<unknown>> }[];
type Row = { name: string; description?: string; inputSchema?: Record<string, unknown>; use: boolean; kind: "read" | "change"; free: boolean; seen: boolean };
type Conflict = { agent: string; tools: string[]; confirming: boolean };

/** Runs a list of steps in order behind one working message. A failure stops there and names the reason; Try again continues at the step that failed. */
function useChain() {
  const plan = useRef<Plan>([]), at = useRef(0), after = useRef<() => void>(() => {});
  const [state, setState] = useState<"idle" | "working" | "failed" | "done">("idle"), [label, setLabel] = useState("");
  const [failure, setFailure] = useState<{ message: string; retryable: boolean } | null>(null);
  async function run(from: number) {
    setState("working"); setFailure(null);
    for (let i = from; i < plan.current.length; i++) {
      at.current = i; setLabel(plan.current[i]!.label);
      const r = await plan.current[i]!.run().catch(() => ({ ok: false as const, message: "That step did not return, so its result is not confirmed.", retryable: false }));
      if (!r.ok) { setFailure({ message: r.message, retryable: r.retryable }); setState("failed"); return; }
    }
    setState("done"); after.current();
  }
  return { state, label, failure, start(steps: Plan, then: () => void) { plan.current = steps; after.current = then; void run(0); },
    retry: () => void run(at.current), reset() { setState("idle"); setFailure(null); } };
}

function WorkNotice({ chain, onStartOver }: { chain: ReturnType<typeof useChain>; onStartOver: () => void }) {
  return <>
    {chain.state === "working" && <Notice tone="working">Working: {chain.label}. This can take a minute while the agent restarts.</Notice>}
    {chain.state === "failed" && chain.failure && <div className="lares-stack">
      <Notice tone="error">{chain.failure.message}</Notice>
      <div className="lares-actions">
        {chain.failure.retryable && <Button type="button" onClick={chain.retry}>Try again</Button>}
        <Button type="button" variant="outline" onClick={onStartOver}>Start over</Button>
      </div>
    </div>}
  </>;
}

/** One agent's tools on this connector: which it may use, what each does, which look-ups run without asking. */
function AgentTools({ use, universe, slug, canWiden, read }: { use: AgentUse; universe: { name: string; kind: "read" | "change" }[]; slug: string; canWiden: boolean; read: Set<string> }) {
  const router = useRouter();
  const [rows, setRows] = useState(() => universe.map(u => { const mine = use.tools.find(t => t.name === u.name); return { name: u.name, allowed: !!mine, kind: mine?.kind ?? u.kind, free: mine?.free ?? false }; }));
  const [busy, setBusy] = useState(false), [note, setNote] = useState<{ tone: "success" | "needs-you" | "error" | "info"; text: string } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [removing, setRemoving] = useState(false);

  async function save(widen = false) {
    setBusy(true); setNote(null); setConflict(null);
    const r = await connectSetTools({ agent: use.agent, name: slug, tools: rows, ...(widen ? { widen: true } : {}) }).catch(() => ({ ok: false as const, message: "Lares could not confirm the save. Reload the page to see what is saved.", retryable: false }));
    setBusy(false);
    if (!r.ok) { setNote({ tone: "error", text: r.message }); return; }
    if (r.value.conflicts.length && !widen) setConflict({ agent: use.agent, tools: r.value.conflicts, confirming: false });
    const dropped = r.value.droppedTrust.length ? ` Run without asking was switched off for ${r.value.droppedTrust.join(", ")} because the tool changed.` : "";
    setNote({ tone: r.value.droppedTrust.length ? "needs-you" : "success", text: `Saved.${dropped}` });
    router.refresh();
  }
  async function takeOff() {
    setBusy(true); setNote({ tone: "info", text: "Taking it off. This can take a minute while the agent restarts." });
    const r = await removeFromAgent({ agent: use.agent, slug }).catch(() => ({ ok: false as const, message: "Lares could not confirm that. Reload the page." }));
    setBusy(false);
    if (!r.ok) { setNote({ tone: "error", text: r.message }); return; }
    router.refresh();
  }

  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(list => list.map((r, k) => k === i ? { ...r, ...patch } : r));
  return <section className="lares-stack" aria-label={`${use.displayName} access`}>
    <h3 className="lares-section-title">{use.displayName}</h3>
    <p className="lares-muted">{use.tools.length} of {universe.length} tools. {whereToolsWork(use.tools.length, use.tools.filter(t => t.free).length)}</p>
    <ToolList label={`Tools for ${use.displayName}`}>{rows.map((row, i) => <ToolRow key={row.name} name={row.name} kind={row.kind}
      control={<Switch aria-label={`${use.displayName} may use ${row.name}`} checked={row.allowed} disabled={!read.has(row.name)} onCheckedChange={on => set(i, { allowed: on, ...(on ? {} : { free: false }) })} />}>
      {!read.has(row.name) && <span className="lares-muted">{use.displayName} has not read this tool&apos;s description. Give access again to review and add it.</span>}
      {row.allowed && row.kind === "read" && <Choice><Switch aria-label={`Run ${row.name} without asking`} checked={row.free} onCheckedChange={on => set(i, { free: on })} /> Run without asking</Choice>}
      {row.allowed && row.kind === "change" && <span className="lares-muted">Always asks you first.</span>}
    </ToolRow>)}</ToolList>
    {conflict && <div className="lares-stack">
      <Notice tone="needs-you">{readOnlyChoiceWords(use.displayName, conflict.tools)}</Notice>
      <div className="lares-actions">
        {!conflict.confirming && <>
          <Button type="button" variant="outline" onClick={() => setConflict(null)}>Leave it out</Button>
          {canWiden ? <Button type="button" onClick={() => setConflict({ ...conflict, confirming: true })}>Let {use.displayName} ask first</Button>
            : <p className="lares-muted">Only the owner can allow this, by widening the agent&apos;s outside access.</p>}
        </>}
        {conflict.confirming && <>
          <p>This widens {use.displayName}&apos;s outside access so it may use tools that change something, always after asking you. It applies to every outside tool of this agent.</p>
          <Button type="button" onClick={() => void save(true)}>Yes, let it ask first</Button>
          <Button type="button" variant="outline" onClick={() => setConflict({ ...conflict, confirming: false })}>Back</Button>
        </>}
      </div>
    </div>}
    {note && <Notice tone={note.tone}>{note.text}</Notice>}
    <div className="lares-actions">
      <Button type="button" disabled={busy} onClick={() => void save()}>Save tools</Button>
      {!removing ? <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoving(true)}>Take off {use.displayName}</Button>
        : <><Button type="button" disabled={busy} onClick={() => void takeOff()}>Yes, take it off {use.displayName}</Button><Button type="button" variant="outline" onClick={() => setRemoving(false)}>Cancel</Button></>}
    </div>
    {removing && <p className="lares-muted">This agent restarts, which ends its open conversations, and the token Lares holds for it is erased.</p>}
  </section>;
}

/** Give more agents the connector. A token is typed once and sent to each chosen agent in this one action. */
function GiveAccess({ conn, agents, canWiden }: { conn: Conn; agents: Agent[]; canWiden: boolean }) {
  const router = useRouter();
  const chain = useChain();
  const [phase, setPhase] = useState<"form" | "pick" | "connecting" | "done">("form");
  const [token, setToken] = useState(""), [consent, setConsent] = useState(false), [toolText, setToolText] = useState("");
  const [ticked, setTicked] = useState<string[]>(agents.length === 1 ? [agents[0]!.name] : []);
  const [rows, setRows] = useState<Row[]>([]), [serverName, setServerName] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [notes, setNotes] = useState<string[]>([]);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const answer = useRef<(a: "leave" | "ask") => void>(() => {}), seen = useRef<ConnectTool[] | undefined>(undefined);
  const needsToken = conn.authKind === "token";
  const nameOf = (a: string) => agents.find(x => x.name === a)?.displayName ?? a;

  /** Back to the form. Whatever a failed run saved is shown again by a refresh of the page. */
  function startOver() { reset(); router.refresh(); }
  function reset() { setPhase("form"); setToken(""); setConsent(false); setRows([]); setError(""); setNotes([]); setConflict(null); chain.reset(); seen.current = undefined; }

  async function findTools() {
    setError("");
    if (ticked.length === 0) { setError("Choose at least one agent."); return; }
    if (!needsToken) {
      const names = toolNamesOf(toolText);
      if (names.length === 0) { setError("This server needs no login, so Lares cannot ask it what it offers. Type the names of the tools you want the agents to use."); return; }
      if (names.some(looksLikeSecret)) { setError(SECRET_AS_NAME_MESSAGE); return; }
      setServerName(""); setRows(names.map(n => ({ name: n, use: true, kind: "change", free: false, seen: false }))); setPhase("pick"); return;
    }
    if (!token.trim()) { setError("Paste the token first."); return; }
    if (!consent) { setError("Tick the box to allow sending the token to this server."); return; }
    setBusy(true);
    const primary = ticked[0]!;
    const base = { name: conn.slug, url: conn.url, description: conn.description || `Tools from ${new URL(conn.url).hostname}`, token: true as const, allow: [], read: [] };
    const declared = await connectDeclare({ agent: primary, provisional: true, connection: base }).catch(() => undefined);
    if (!declared || !declared.ok) { setBusy(false); setError(declared?.message ?? "Lares could not save the connector on the first agent."); return; }
    const looked = await connectLookUpTools({ agent: primary, name: conn.slug, credential: token }).catch(() => undefined);
    if (!looked || !looked.ok) {
      // The look-up may already have stored a token revision: removeFromAgent erases it first, then takes the temporary declaration back.
      const gone = await removeFromAgent({ agent: primary, slug: conn.slug }).catch(() => undefined);
      const why = looked?.message ?? "Lares could not ask the server for its tools.";
      setError(gone && gone.ok ? why : `${why} The stored token and the temporary connection could not be erased either (${gone?.message ?? "Lares could not confirm it"}); reload the page and take the connector off ${nameOf(primary)} if it appears.`);
      if (looked && !looked.retryable) setToken("");
      setBusy(false); return;
    }
    setBusy(false);
    seen.current = looked.value.tools; setServerName(looked.value.serverName);
    setRows(looked.value.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, use: true, kind: t.readOnly ? "read" : "change", seen: true, free: t.readOnly === true })));
    setPhase("pick");
  }

  /** A token connector has a temporary declaration on the first agent while the owner reads the tool list; Cancel takes it back, as the old screen did. */
  async function cancel() {
    if (needsToken && ticked[0]) {
      setBusy(true);
      const gone = await removeFromAgent({ agent: ticked[0], slug: conn.slug }).catch(() => undefined);
      setBusy(false);
      if (!gone || !gone.ok) { setError(`The stored token and the temporary connection could not be erased: ${gone?.message ?? "Lares could not confirm it. Reload the page."}`); return; }
    }
    reset();
  }

  function ask(agent: string, tools: string[]): Promise<"leave" | "ask"> {
    return new Promise(resolve => { answer.current = a => { setConflict(null); resolve(a); }; setConflict({ agent, tools, confirming: false }); });
  }

  function connect() {
    const use = rows.filter(r => r.use);
    if (use.length === 0) { setError("Choose at least one tool."); return; }
    setError(""); setNotes([]);
    const connection = { name: conn.slug, url: conn.url, description: conn.description || `Tools from ${new URL(conn.url).hostname}`, token: needsToken,
      allow: use.map(r => r.name), read: use.filter(r => r.kind === "read").map(r => r.name) };
    const free = use.filter(r => r.kind === "read" && r.free && r.seen).map(r => r.name);
    const steps: Plan = [];
    for (const agent of ticked) {
      const declare = async (applyNow: boolean): Promise<ConnectStep<unknown>> => {
        let r = await connectDeclare({ agent, provisional: false, connection, ...(applyNow ? {} : { applyNow: false }) });
        if (r.ok && r.value.conflicts.length) {
          const tools = r.value.conflicts;
          if (await ask(agent, tools) === "ask") { r = await connectDeclare({ agent, provisional: false, connection, widen: true, ...(applyNow ? {} : { applyNow: false }) }); if (r.ok) setNotes(n => [...n, `${tools.length} tool${tools.length === 1 ? " may" : "s may"} be used by ${nameOf(agent)}, always after asking you first.`]); }
          else setNotes(n => [...n, `${tools.length} tool${tools.length === 1 ? "" : "s"} left out for ${nameOf(agent)}, whose outside access is read-only.`]);
        }
        return r;
      };
      if (!needsToken) { steps.push({ label: nameOf(agent), run: () => declare(true) }); continue; }
      let identity: ConnectIdentity | undefined, staged: OutsidePendingApplyDto | undefined;
      steps.push(
        { label: `saving the tools on ${nameOf(agent)}`, run: () => declare(false) },
        { label: `checking ${nameOf(agent)} sees what you saw`, run: async () => { const r = await connectLookUpTools({ agent, name: conn.slug, credential: token }); if (r.ok) identity = r.value.identity; return r; } },
        { label: `recording the exact descriptions for ${nameOf(agent)}`, run: async () => {
          if (!identity) return { ok: false as const, message: "The previous step has no result. Start over.", retryable: false };
          const r = await connectReviewAndStage({ identity, ...(seen.current ? { seen: seen.current } : {}) }); if (r.ok) staged = r.value; return r; } },
        { label: `locking the token away for ${nameOf(agent)}`, run: async () => {
          if (!staged) return { ok: false as const, message: "The previous step has no result. Start over.", retryable: false };
          return connectActivateCredential({ staged }); } },
        { label: `switching on look-ups that run without asking for ${nameOf(agent)}`, run: async () => {
          const r = await connectSwitchOnTrust({ agent, name: conn.slug, tools: free });
          if (!r.ok) setNotes(n => [...n, `${nameOf(agent)}: ${r.message}`]);
          return { ok: true as const, value: null }; } },
        { label: `applying to ${nameOf(agent)}`, run: () => connectApplyAgent({ agent }) },
      );
    }
    setPhase("connecting");
    chain.start(steps, () => { setToken(""); setPhase("done"); router.refresh(); });
  }

  // After a successful run the page refreshes and no agent is left to add; the result stays on screen until the owner moves on.
  if (agents.length === 0 && phase === "form") return <p className="lares-muted">Every agent already has this connector.</p>;
  const usedCount = rows.filter(r => r.use).length;
  return <section className="lares-stack" aria-label="Give agents access">
    {phase === "form" && <div className="lares-stack">
      <FieldGroup legend="Give access to">
        {agents.map(a => <Choice key={a.name}><Checkbox checked={ticked.includes(a.name)} onChange={e => setTicked(l => e.target.checked ? [...l, a.name] : l.filter(n => n !== a.name))} /> {a.displayName}</Choice>)}
      </FieldGroup>
      {needsToken ? <>
        <Field label="Token" hint="Typed once. Lares locks it away for each agent you chose; the agents never see it."><Input type="password" autoComplete="off" maxLength={4096} value={token} onChange={e => setToken(e.target.value)} /></Field>
        <Choice><Checkbox checked={consent} onChange={e => setConsent(e.target.checked)} /> I allow Lares to send this token to the server above, once to read its tools and once for each agent.</Choice>
      </> : <Field label="Tools the agents may use" hint="With no login Lares cannot ask the server for its tool list. Type the tool names, separated by commas."><Input value={toolText} onChange={e => setToolText(e.target.value)} /></Field>}
      {busy && <Notice tone="working">Asking the server which tools it offers.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="lares-actions"><Button type="button" disabled={busy} onClick={() => void findTools()}>{needsToken ? "Find tools" : "Continue"}</Button></div>
    </div>}
    {phase === "pick" && <div className="lares-stack">
      <h3 className="lares-section-title">{serverName ? `${serverName} offers ${rows.length} tool${rows.length === 1 ? "" : "s"}` : "Tools you chose"}</h3>
      <p>Tools the server marks as read-only start as &ldquo;Looks things up&rdquo; and run without asking; everything else changes something and always asks. If the server later changes a tool&apos;s description, that tool stops until you review it again.</p>
      <ToolList label="Tools to connect">{rows.map((row, i) => <ToolRow key={row.name} name={row.name} kind={row.kind} description={row.description}
        control={<Switch aria-label={`Use ${row.name}`} checked={row.use} onCheckedChange={on => setRows(l => l.map((r, k) => k === i ? { ...r, use: on } : r))} />}>
        {row.seen && row.kind === "read" && <Choice><Switch aria-label={`Run ${row.name} without asking`} checked={row.free} disabled={!row.use} onCheckedChange={on => setRows(l => l.map((r, k) => k === i ? { ...r, free: on } : r))} /> Run without asking</Choice>}
        {row.inputSchema && <details><summary>What it asks for</summary><pre>{JSON.stringify(row.inputSchema, null, 2)}</pre></details>}
      </ToolRow>)}</ToolList>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="lares-actions"><Button type="button" onClick={connect}>Give access</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>Cancel</Button></div>
    </div>}
    {phase === "connecting" && <div className="lares-stack">
      <WorkNotice chain={chain} onStartOver={startOver} />
      {conflict && <div className="lares-stack">
        <Notice tone="needs-you">{readOnlyChoiceWords(nameOf(conflict.agent), conflict.tools)}</Notice>
        <div className="lares-actions">
          {!conflict.confirming && <>
            <Button type="button" variant="outline" onClick={() => answer.current("leave")}>Leave it out</Button>
            {canWiden ? <Button type="button" onClick={() => setConflict({ ...conflict, confirming: true })}>Let {nameOf(conflict.agent)} ask first</Button>
              : <p className="lares-muted">Only the owner can allow this, by widening the agent&apos;s outside access.</p>}
          </>}
          {conflict.confirming && <>
            <p>This widens {nameOf(conflict.agent)}&apos;s outside access so it may use tools that change something, always after asking you. It applies to every outside tool of this agent.</p>
            <Button type="button" onClick={() => answer.current("ask")}>Yes, let it ask first</Button>
            <Button type="button" variant="outline" onClick={() => setConflict({ ...conflict, confirming: false })}>Back</Button>
          </>}
        </div>
      </div>}
    </div>}
    {phase === "done" && <div className="lares-stack">
      <Notice tone="success">Done. {ticked.map(nameOf).join(", ")} can now use {usedCount} tool{usedCount === 1 ? "" : "s"}. {whereToolsWork(usedCount, rows.filter(r => r.use && r.kind === "read" && r.free && r.seen).length)}</Notice>
      {notes.map((n, i) => <Notice key={i} tone="info">{n}</Notice>)}
      <div className="lares-actions"><Button type="button" variant="outline" onClick={reset}>Give access to more</Button></div>
    </div>}
  </section>;
}

/**
 * Replace the token for the agents that hold one. The new token reads the tool list once; the owner sees the exact descriptions and accepts
 * them in the same press that replaces the token, so a server that changed a description since it was last accepted is read, never waved through.
 * Each agent's step then checks the server still says what the owner was shown.
 */
function ReplaceToken({ conn, agents }: { conn: Conn; agents: Agent[] }) {
  const router = useRouter();
  const chain = useChain();
  const [phase, setPhase] = useState<"closed" | "form" | "review">("closed");
  const [token, setToken] = useState(""), [error, setError] = useState(""), [done, setDone] = useState(false), [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState<string[]>(agents.map(a => a.name)), [tools, setTools] = useState<ConnectTool[]>([]);
  function close() { setPhase("closed"); setToken(""); setError(""); setTools([]); chain.reset(); }
  async function read() {
    setError(""); setDone(false);
    if (!token.trim()) { setError("Paste the new token first."); return; }
    if (ticked.length === 0) { setError("Choose at least one agent."); return; }
    setBusy(true);
    const r = await connectLookUpTools({ agent: ticked[0]!, name: conn.slug, credential: token }).catch(() => undefined);
    setBusy(false);
    if (!r || !r.ok) { setError(r?.message ?? "Lares could not ask the server for its tools."); if (r && !r.retryable) setToken(""); return; }
    setTools(r.value.tools); setPhase("review");
  }
  function replace() {
    const steps: Plan = [];
    for (const agent of ticked) {
      let identity: ConnectIdentity | undefined, staged: OutsidePendingApplyDto | undefined;
      steps.push(
        { label: `reading the tools for ${agent}`, run: async () => { const r = await connectLookUpTools({ agent, name: conn.slug, credential: token }); if (r.ok) identity = r.value.identity; return r; } },
        // `seen`: the descriptions the owner read. If the server now says something else, nothing is accepted.
        { label: `recording the descriptions for ${agent}`, run: async () => { if (!identity) return { ok: false as const, message: "The previous step has no result. Start over.", retryable: false }; const r = await connectReviewAndStage({ identity, seen: tools }); if (r.ok) staged = r.value; return r; } },
        { label: `locking the new token away for ${agent}`, run: async () => { if (!staged) return { ok: false as const, message: "The previous step has no result. Start over.", retryable: false }; return connectActivateCredential({ staged }); } },
      );
    }
    chain.start(steps, () => { setToken(""); setDone(true); setPhase("closed"); setTools([]); router.refresh(); });
  }
  if (agents.length === 0) return null;
  return <div className="lares-stack">
    {phase === "closed" && <div className="lares-actions"><Button type="button" variant="outline" onClick={() => { setPhase("form"); chain.reset(); }}>Replace token</Button></div>}
    {phase === "form" && <div className="lares-stack">
      <FieldGroup legend="Replace the token for">{agents.map(a => <Choice key={a.name}><Checkbox checked={ticked.includes(a.name)} onChange={e => setTicked(l => e.target.checked ? [...l, a.name] : l.filter(n => n !== a.name))} /> {a.displayName}</Choice>)}</FieldGroup>
      <Field label="New token" hint="Typed once. Lares reads the server's tools with it so you can see their descriptions before anything is replaced."><Input type="password" autoComplete="off" maxLength={4096} value={token} onChange={e => setToken(e.target.value)} /></Field>
      {busy && <Notice tone="working">Asking the server which tools it offers.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="lares-actions"><Button type="button" disabled={busy} onClick={() => void read()}>Read the tools</Button><Button type="button" variant="outline" onClick={close}>Cancel</Button></div>
    </div>}
    {phase === "review" && <div className="lares-stack">
      <h3 className="lares-section-title">Read these descriptions before the token is replaced</h3>
      <p>If the server changed a description since you last accepted it, this is where you see it. Accepting records exactly this text.</p>
      <ToolList label="Descriptions the server gives now">{tools.map(t => <ToolRow key={t.name} name={t.name} kind={t.readOnly ? "read" : "change"} description={t.description}>
        {t.inputSchema && <details><summary>What it asks for</summary><pre>{JSON.stringify(t.inputSchema, null, 2)}</pre></details>}</ToolRow>)}</ToolList>
      <WorkNotice chain={chain} onStartOver={close} />
      <div className="lares-actions"><Button type="button" disabled={chain.state === "working"} onClick={replace}>Accept these descriptions and replace the token</Button><Button type="button" variant="outline" onClick={close}>Cancel</Button></div>
    </div>}
    {done && <Notice tone="success">The new token is locked away.</Notice>}
  </div>;
}

/** Everything on the connector page that changes who can use it. */
export function ConnectorAccess({ conn, uses, allAgents, canWiden, keyLines, known = {} }: { conn: Conn; uses: AgentUse[]; allAgents: Agent[]; canWiden: boolean; keyLines: Record<string, string>; known?: Record<string, string[]> }) {
  const universe = (() => {
    const seenNames = new Map<string, "read" | "change">();
    for (const u of uses) for (const t of u.tools) if (!seenNames.has(t.name) || t.kind === "change") seenNames.set(t.name, t.kind);
    // A tool the agents have read from the server but none may use now stays listed (always asks), so it can be switched on again.
    for (const list of Object.values(known)) for (const name of list) if (!seenNames.has(name)) seenNames.set(name, "change");
    return [...seenNames].map(([name, kind]) => ({ name, kind }));
  })();
  const without = allAgents.filter(a => !uses.some(u => u.agent === a.name));
  if (conn.authKind === "signin") return <Notice tone="needs-you">This server uses a sign-in page. Sign-in comes in a later release, so no agent can use it yet.</Notice>;
  return <div className="lares-stack">
    <h2 className="lares-section-title">Who can use it</h2>
    {uses.length === 0 && <p className="lares-muted">No agent uses this connector yet.</p>}
    {uses.map(u => <div key={u.agent} className="lares-stack">
      <AgentTools use={u} universe={universe} slug={conn.slug} canWiden={canWiden} read={new Set([...u.tools.map(t => t.name), ...(known[u.agent] ?? [])])} />
      {u.needsKey && keyLines[u.agent] && <p className="lares-muted">{keyLines[u.agent]}</p>}
    </div>)}
    {conn.authKind === "token" && <ReplaceToken conn={conn} agents={allAgents.filter(a => uses.some(u => u.agent === a.name && u.needsKey))} />}
    <h2 className="lares-section-title">{uses.length ? "Give another agent access" : "Give an agent access"}</h2>
    <GiveAccess conn={conn} agents={without} canWiden={canWiden} />
  </div>;
}
