"use client";
import { AvatarEditor } from "./AvatarEditor";
import { DoorSetup } from "./DoorSetup";
import React, { useEffect, useRef, useState } from "react";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { Select } from "@lares/ui/primitives/select";
import { Textarea } from "@lares/ui/primitives/textarea";
import { Checkbox, Radio } from "@lares/ui/primitives/checkbox";
import { Choice, Field, FieldGroup, Notice } from "@lares/ui/patterns";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@lares/ui/primitives/dialog";

import { useRouter } from "next/navigation";
import {
  assertSkillsWithinGrants,
  KNOWN_CAPABILITIES,
  KNOWN_SKILLS,
} from "@lares/agent-kit/skill-grants";
import type { AgentDefinition } from "@lares/agent-kit/definition";
import type {
  Capacity,
  DefinitionResult,
  Role,
  RuntimeState,
  StartingPoint,
} from "../lib/builder";
import type { BoardRowDTO } from "../lib/contracts";
import {
  createAgent,
  saveDefinition,
  retireAgent,
  deleteAgent,
  applyConnections,
  agentRuntime,
} from "../app/actions/definition";
import { ConversationControl } from "./ConversationControl";
import { AutonomyControl } from "./AutonomyControl";
import { TakesEffect } from "./TakesEffect";
import { CeilingNotice } from "./CeilingNotice";
import { scheduleExplanation, scheduleLabel } from "../lib/schedule-labels";
import { afterCreationPath } from "../lib/first-conversation";
import { withStartingDelivery } from "../lib/delivery";

export interface DefinitionFormProps {
  publicDoorOrigin?: string;
  startingPoints: StartingPoint[];
  aliases: { alias: string; label: string; when: string }[];
  timing: Record<string, string>;
  capacity: Capacity;
  initial?: {
    definition: AgentDefinition;
    duties: string;
    voice: string;
    hash: string;
    runtime?: RuntimeState;
    status: string;
    avatarVersion?: string;
  };
  permissions?: BoardRowDTO[];
}
const LANGUAGES = [
  "English",
  "Norwegian",
  "Swedish",
  "Danish",
  "French",
  "German",
  "Spanish",
];
// What "Create agent" really does on the server, in order (keeper definition.create): save the
// definition files and a backup, then start the agent. The console gets one answer at the end, so
// the first two steps show as in progress together rather than pretending to report each one.
export const CREATE_STEPS = ["Saving the definition", "Starting the agent", "Ready"] as const;
export const CREATE_WORKING = "Creating your agent. This can take up to a minute, so please stay on this page.";
export const CREATE_DONE = "Your agent is ready. Opening its first conversation…";
export const CREATE_FAILED = "The agent could not be created. The reason is below. Before you try again, check the agents list, because part of it may already exist.";

export function DefinitionForm(p: DefinitionFormProps) {
  const router = useRouter();
  const editing = Boolean(p.initial);
  const first = p.startingPoints[0];
  const fresh = (point: StartingPoint): AgentDefinition => ({
    ...point.definition,
    name: "",
    gender: "agent",
    description: "",
    language: "English",
    model: p.aliases[0]?.alias ?? "",
    duties: "duties.md",
    doors: [],
    channels: [],
  });
  const [definition, setDefinition] = useState<AgentDefinition>(
    p.initial?.definition ?? fresh(first),
  );
  const [duties, setDuties] = useState(p.initial?.duties ?? "");
  const [voice, setVoice] = useState(p.initial?.voice ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [creating, setCreating] = useState<"idle" | "working" | "done" | "failed">("idle");
  const [runtime, setRuntime] = useState(p.initial?.runtime);
  const nativeHeld = !runtime?.pending && runtime?.reason === "Native budget activation required";
  const [hash, setHash] = useState(p.initial?.hash ?? "");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [retireConfirm, setRetireConfirm] = useState(false);
  const [confirmationName, setConfirmationName] = useState("");
  const [step, setStep] = useState(0);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const snapshot = JSON.stringify({ definition, duties, voice });
  const [savedSnapshot, setSavedSnapshot] = useState(snapshot);
  const dirty = snapshot !== savedSnapshot;
  const running = useRef(false);
  useEffect(() => {
    // Once a write's outcome is unknown the page asks for a reload, so it must not also block one.
    if (!dirty || uncertain) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element)?.closest("a");
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      const url = new URL(anchor.href, window.location.href);
      if (
        url.href === window.location.href ||
        (url.protocol !== "http:" && url.protocol !== "https:")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setLeaveTo(url.href);
    };
    window.addEventListener("beforeunload", before);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", before);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty, uncertain]);
  const point = p.startingPoints.find((s) => s.id === definition.role) ?? first;
  const active = !p.initial || p.initial.status !== "retired";
  const timing = (field: string) =>
    editing || field === "startingPoint" ? (
      <TakesEffect text={p.timing[field]} />
    ) : null;
  let validation = "";
  try {
    assertSkillsWithinGrants(definition);
  } catch (e) {
    validation = e instanceof Error ? e.message : String(e);
  }
  // A saved grant whose capability this version of Lares no longer knows. The keeper refuses a
  // definition that still holds one, so it is shown by name with a remove control and is only
  // ever dropped when the owner presses it.
  const retiredGrants = definition.grants.filter(
    (g) => !(KNOWN_CAPABILITIES as readonly string[]).includes(g.capability),
  );
  // A saved skill is retired when its name is gone or it needs a capability that is gone. The
  // skills list only shows ticks for the starting point's skills, so these get their own notice.
  const retiredSkills = definition.skills.filter(
    (k) =>
      !(KNOWN_SKILLS as readonly string[]).includes(k.name) ||
      k.requires.some(
        (r) => !(KNOWN_CAPABILITIES as readonly string[]).includes(r.capability),
      ),
  );
  const skillsNeeding = (capability: string) =>
    definition.skills.filter((k) =>
      k.requires.some((r) => r.capability === capability),
    );
  const validName = /^[a-z][a-z0-9-]{1,30}$/.test(definition.name);
  const validModel = p.aliases.some((a) => a.alias === definition.model);
  const patch = (value: Partial<AgentDefinition>) =>
    setDefinition((d) => ({ ...d, ...value }));
  // The edit page shows every part at once, in two cards; the create dialog folds the longer parts away.
  const Sub = editing ? "h3" : "h2";
  const group = (summary: React.ReactNode, title: string | null, open: boolean, children: React.ReactNode) =>
    editing ? (
      <div className="lares-edit-group">
        {title && <h3>{title}</h3>}
        {children}
      </div>
    ) : (
      <details className="lares-disclosure" open={open}>
        <summary>{summary}</summary>
        {children}
      </details>
    );
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      // The keeper can fail after disk publication or after transmission. Never retry implicitly,
      // claim rollback, or invite a duplicate create. Reload authoritative state before another write.
      const unknown = !(
        e instanceof Error &&
        "outcomeMayBeUnknown" in e &&
        e.outcomeMayBeUnknown === false
      );
      setError(
        `${e instanceof Error ? e.message : String(e)}${unknown ? " Inspect the current state before trying again; some changes may already have taken effect." : ""}`,
      );
      setUncertain(unknown);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function saved(result: DefinitionResult) {
    setHash(result.hash);
    setRuntime(result.runtime);
    setSavedSnapshot(snapshot);
    setMessage(
      `Definition saved.${result.backup.ok ? "" : ` ${result.backup.message ?? "Git backup failed; the definition remains saved."}`}`,
    );
  }
  const feedback = (
    <>
      {message && <p role="status">{message}</p>}
      {error && !(editing && uncertain) && <p role="alert">{error}</p>}
    </>
  );
  const content = (
    <div className={editing ? "lares-editor lares-agent-edit" : "lares-editor"}>
      {!editing && (
        <ol className="lares-steps" aria-label="Create agent progress">
          {["Purpose", "Identity & access", "Review"].map((label, index) => (
            <li key={label} aria-current={step === index ? "step" : undefined}>
              {index + 1} {label}
            </li>
          ))}
        </ol>
      )}
      {!active && (
        <p role="status">
          This agent is retired and stopped. Its definition is read-only;
          permanent deletion remains available below.
        </p>
      )}
      {editing && uncertain && (
        <Notice error={Boolean(error)}>
          <p>
            {error
              ? `This change could not be confirmed. ${error}`
              : "This agent changed. Reload to see its current state before editing it again."}
          </p>
          <Button type="button" onClick={() => window.location.reload()}>
            Reload this agent’s current state
          </Button>
        </Notice>
      )}
      {editing && (
        <section className="lares-surface">
          <h2>Status</h2>
          <p>
            {!active
              ? "Agent stopped."
              : nativeHeld
                ? "Native budget activation is required before this agent can start."
                : runtime?.pending
                ? `Connection changes are pending. ${runtime.reason ?? ""}`
                : runtime?.running === false
                  ? "Agent stopped."
                  : runtime?.running && runtime.healthy === false
                    ? "Started, not answering yet. A first start after an upgrade can take several minutes; reload to check. If it stays like this, its log says why."
                    : runtime?.running && runtime.healthy
                      ? "Running. Saved connections are applied."
                      : runtime
                        ? "Saved connections are applied."
                        : "Runtime connection status is unavailable."}
          </p>
          {!nativeHeld && (runtime?.pending ||
            (active &&
              runtime?.running === false &&
              p.initial?.status === "valid")) && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || uncertain || !hash || !active}
              onClick={() =>
                void run(async () => {
                  const response = await applyConnections({
                    name: definition.name,
                    hash,
                  });
                  if (!response.ok) throw new Error(response.error.message);
                  setMessage(
                    "Connection changes applied. Reload to inspect runtime state.",
                  );
                  router.refresh();
                  setUncertain(true);
                })
              }
            >
              {runtime?.pending
                ? "Apply connection changes (restarts agent)"
                : "Start agent (applies saved definition)"}
            </Button>
          )}
          {active && <ConversationControl name={definition.name} />}
        </section>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            validation ||
            !validName ||
            !validModel ||
            uncertain ||
            (!editing && step !== 2)
          )
            return;
          void run(async () => {
            // A new chief of staff starts with every kind of message going to its first chat door,
            // then web chat (web chat alone when no chat door is declared yet).
            const started = withStartingDelivery(definition, point.id, !editing);
            const input = { name: definition.name, definition: started, duties, voice };
            if (!editing) setCreating("working");
            try {
            const result = editing
              ? await saveDefinition(input)
              : await createAgent({
                  ...input,
                  startingPoint: point.id as Role,
                });
            if (!result.ok)
              throw Object.assign(
                new Error(
                  [
                    result.error.message,
                    ...(result.error.findings ?? []).map(
                      (f) => `[${f.check}] ${f.message}`,
                    ),
                  ].join("\n"),
                ),
                { outcomeMayBeUnknown: result.error.outcomeMayBeUnknown },
              );
            saved(result.result);
            if (!editing) {
              setUncertain(true);
              router.push(
                afterCreationPath(definition.name, result.result.backup.status ?? (result.result.backup.ok ? "saved" : "failed")),
              );
            }
            if (!editing) setCreating("done");
            } catch (e) {
              if (!editing) setCreating("failed");
              throw e;
            }
          });
        }}
      >
        <FieldGroup
          legend={<span className="sr-only">Agent definition</span>}
          disabled={busy || uncertain || !active}
        >
          {!editing && (
            <section hidden={step !== 0}>
              <h2 className="sr-only">Choose a purpose</h2>
              {p.startingPoints.map((s) => (
                <label key={s.id} className="lares-purpose">
                  <Radio
                    name="startingPoint"
                    checked={point.id === s.id}
                    onChange={() =>
                      setDefinition({
                        ...fresh(s),
                        name: definition.name,
                        display: definition.display,
                        gender: definition.gender,
                        description: definition.description,
                      })
                    }
                  />{" "}
                  <strong>{s.label}</strong>
                  <p>{s.description}</p>
                </label>
              ))}
              {timing("startingPoint")}
            </section>
          )}
          <section hidden={!editing && step !== 1} className={editing ? "lares-grid" : undefined}>
          <div className={editing ? "lares-surface" : undefined}>
            <h2>{editing ? "Who it is" : "Identity"}</h2>
            {!editing && (
              <>
                <Field label="Name (permanent slug)">
                  <Input
                    required
                    pattern="[a-z][a-z0-9-]{1,30}"
                    minLength={2}
                    maxLength={31}
                    value={definition.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </Field>
                <p>
                  Lowercase letters, digits and hyphens, starting with a letter.
                  The name cannot change later.
                </p>
                {timing("name")}
              </>
            )}
            {editing && (
              <p>
                Permanent name: <strong>{definition.name}</strong>
              </p>
            )}
            <Field label="Display name">
              <Input
                maxLength={80}
                value={definition.display ?? ""}
                onChange={(e) => patch({ display: e.target.value })}
              />
            </Field>
            <Field label="Gender">
              <Select
                value={definition.gender ?? "agent"}
                onChange={(e) =>
                  patch({ gender: e.target.value as AgentDefinition["gender"] })
                }
              >
                <option value="agent">Agent</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </Select>
            </Field>
            <Field label="Description">
              <Input
                value={definition.description ?? ""}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
            {timing("description")}
            {group(
              <>Instructions and language</>,
              "Instructions and language",
              editing,
              <>
              <p className="lares-muted">
                Every agent starts from a built-in description of its role,
                with its safety rules. What you write here is added after it.
                It does not replace it, and it cannot loosen the safety rules.
              </p>
              {point.roleMd && (
                <details className="lares-inset-disclosure">
                  <summary>Show the built-in default</summary>
                  <pre className="lares-muted lares-editor-default">
                    {point.roleMd}
                  </pre>
                </details>
              )}
              <Field
                label="What is this agent for? Write it the way you would tell a person."
              >
                <Textarea
                  rows={5}
                  value={duties}
                  onChange={(e) => setDuties(e.target.value)}
                />
              </Field>
              <Field
                label="Personality"
                hint="How the agent sounds and writes. Added after the built-in role, not instead of it."
              >
                <Textarea
                  rows={4}
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                />
              </Field>
              <Field
                label="Language"
                hint="The agent’s default language. It switches to another one only when someone asks it to, and only for that conversation."
              >
                <Select
                  required
                  value={definition.language ?? ""}
                  onChange={(e) => patch({ language: e.target.value })}
                >
                  {!definition.language && (
                    <option value="">Choose a language</option>
                  )}
                  {[
                    ...new Set([
                      ...LANGUAGES,
                      ...(definition.language ? [definition.language] : []),
                    ]),
                  ].map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </Select>
              </Field>
              {timing("language")}
                          </>,
            )}
            {group(
              <>Model</>,
              "Model",
              !validModel,
              <>
              <Field label="Purpose">
                <Select
                  required
                  value={definition.model}
                  onChange={(e) => patch({ model: e.target.value })}
                >
                  {!validModel && (
                    <option value="">Choose a configured purpose alias</option>
                  )}
                  {p.aliases.map((a) => (
                    <option key={a.alias} value={a.alias}>
                      {a.label} — {a.alias}
                    </option>
                  ))}
                </Select>
              </Field>
              {p.aliases.map((a) => (
                <p key={a.alias}>
                  <strong>{a.label}:</strong> {a.when}
                </p>
              ))}
              {timing("model")}
                          </>,
            )}
          </div>
          <div className={editing ? "lares-surface" : undefined}>
            {editing && <h2>What it can do</h2>}
            {group(
              <>Access and skills · {definition.grants.length} integrations</>,
              null,
              !editing,
              <>
              <Sub>Integrations</Sub>
              {retiredGrants.map((g) => {
                const dependents = skillsNeeding(g.capability);
                return (
                  <div
                    key={g.capability}
                    role="status"
                    data-retired-grant={g.capability}
                    className="lares-editor-item"
                  >
                    <strong>{g.capability}</strong> ({g.scope}): no longer
                    available in this version. Saving is refused while it stays.
                    {dependents.length > 0 && (
                      <>
                        {" "}
                        Removing it also removes the skill
                        {dependents.length > 1 ? "s" : ""}{" "}
                        {dependents.map((k) => k.name).join(", ")}, which
                        need{dependents.length > 1 ? "" : "s"} it.
                      </>
                    )}{" "}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        patch({
                          grants: definition.grants.filter(
                            (x) => x.capability !== g.capability,
                          ),
                          skills: definition.skills.filter(
                            (k) => !dependents.some((d) => d.name === k.name),
                          ),
                          autonomy: Object.fromEntries(
                            Object.entries(definition.autonomy).filter(
                              ([k]) => k !== g.capability,
                            ),
                          ),
                        })
                      }
                    >
                      Remove {g.capability}
                    </Button>
                  </div>
                );
              })}
              {retiredSkills
                .filter(
                  (k) =>
                    !retiredGrants.some((g) =>
                      k.requires.some((r) => r.capability === g.capability),
                    ),
                )
                .map((k) => (
                  <div
                    key={k.name}
                    role="status"
                    data-retired-skill={k.name}
                    className="lares-editor-item"
                  >
                    Skill <strong>{k.name}</strong>: no longer available in this
                    version. Saving is refused while it stays.{" "}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        patch({
                          skills: definition.skills.filter(
                            (x) => x.name !== k.name,
                          ),
                        })
                      }
                    >
                      Remove skill {k.name}
                    </Button>
                  </div>
                ))}
              <div className="lares-choice-list">
              {point.definition.grants.map((g) => (
                <Choice key={g.capability}>
                  <Checkbox
                    checked={definition.grants.some(
                      (x) => x.capability === g.capability,
                    )}
                    onChange={(e) => {
                      const grants = e.target.checked
                        ? [...definition.grants, g]
                        : definition.grants.filter(
                            (x) => x.capability !== g.capability,
                          );
                      const autonomy = Object.fromEntries(
                        grants.map((x) => [
                          x.capability,
                          definition.autonomy[x.capability] ?? "gated",
                        ]),
                      );
                      patch({ grants, autonomy });
                    }}
                  />
                  {g.capability} ({g.scope})
                </Choice>
              ))}
              </div>
              <Sub>Skills</Sub>
              <div className="lares-choice-list">
              {point.definition.skills?.map((s) => (
                <Choice key={s.name}>
                  <Checkbox
                    checked={definition.skills.some((x) => x.name === s.name)}
                    onChange={(e) =>
                      patch({
                        skills: e.target.checked
                          ? [...definition.skills, s]
                          : definition.skills.filter((x) => x.name !== s.name),
                      })
                    }
                  />
                  {s.name} — needs{" "}
                  {s.requires
                    .map((r) => `${r.capability}: ${r.scope}`)
                    .join(", ")}
                </Choice>
              ))}
              </div>
              {timing("skills")}
              {validation && <Notice error>{validation}</Notice>}
              <Sub>Permission levels</Sub>
              <p>
                <a href="/integrations">Open the permissions board</a> for
                evidence and always-ask actions.
              </p>
              {!editing ? (
                <p>
                  Create this agent first, then set its permission levels here.
                  New agents start with the starting point’s permission levels.
                </p>
              ) : (
                <>
                  {(p.permissions ?? [])
                    .filter((row) =>
                      definition.grants.some(
                        (g) => g.capability === row.capability,
                      ),
                    )
                    .map((row) => (
                      <div
                        key={`${row.capability}:${row.action}`}
                        className="lares-editor-row"
                      >
                        <strong>
                          {row.capability}
                          {row.actionLabel ? ` · ${row.actionLabel}` : ""}
                        </strong>{" "}
                        {row.controllable ? (
                          <AutonomyControl
                            agent={definition.name}
                            capability={row.capability}
                            action={row.action || undefined}
                            level={row.level}
                          />
                        ) : (
                          <span>
                            {row.scope === "write"
                              ? "Acts without asking — plain write grant."
                              : "Reads — allowed while granted."}
                          </span>
                        )}
                        {row.lockedTools.map((t) => (
                          <p key={t.tool}>
                            🔒 {t.tool}: {t.reason}
                          </p>
                        ))}
                      </div>
                    ))}
                  <p>
                    These controls save immediately, independently of the
                    definition.
                  </p>
                </>
              )}
              {timing("autonomy")}
                          </>,
            )}
            {group(
              <>Schedules · {Object.values(definition.schedules).filter((s) => s.on).length} enabled</>,
              "Schedules",
              false,
              <>
              <div className="lares-choice-list">
              {Object.entries(definition.schedules).map(([name, s]) => (
                <Choice key={name}>
                  <Checkbox
                    checked={s.on}
                    onChange={(e) =>
                      patch({
                        schedules: {
                          ...definition.schedules,
                          [name]: { ...s, on: e.target.checked },
                        },
                      })
                    }
                  />
                  <span>
                    {scheduleLabel(name)}
                    {scheduleExplanation(name) && (
                      <span className="lares-muted lares-choice-detail">
                        {scheduleExplanation(name)}
                      </span>
                    )}
                  </span>
                </Choice>
              ))}
              </div>
              {timing("schedules")}
                          </>,
            )}
            {editing && (
              <>
                <Sub>Doors</Sub>
                {(
                  definition.doors ??
                  definition.channels.map((kind) => ({ kind, enabled: true }))
                ).map((door) => (
                  <p key={door.kind}>
                    {door.kind}:{" "}
                    {door.enabled ? "enabled in saved definition" : "disabled"}
                    {runtime?.pending ? " — connection changes pending" : ""}
                  </p>
                ))}
                <p>
                  Configure saved doors below. Saving a definition does not
                  apply a connection.
                </p>
                {timing("doors")}
              </>
            )}
          </div>
          </section>
          {!editing && step === 2 && (
            <section className="lares-surface">
              <h2>Review your agent</h2>
              <dl className="lares-review">
                <dt>Purpose</dt>
                <dd>{point.label}</dd>
                <dt>Name</dt>
                <dd>{definition.display || definition.name}</dd>
                <dt>Permanent address</dt>
                <dd>{definition.name}</dd>
                <dt>Model</dt>
                <dd>{definition.model}</dd>
                <dt>Language</dt>
                <dd>{definition.language}</dd>
                <dt>Access</dt>
                <dd>
                  {definition.grants
                    .map((g) => `${g.capability}: ${g.scope}`)
                    .join(", ") || "None"}
                </dd>
                <dt>Enabled schedules</dt>
                <dd>
                  {Object.entries(definition.schedules)
                    .filter(([, v]) => v.on)
                    .map(([k]) => k)
                    .join(", ") || "None"}
                </dd>
              </dl>
              <p>
                Creating starts this agent with the access and schedules shown
                above.
              </p>
            </section>
          )}
          <CeilingNotice capacity={p.capacity} />
          {!(editing && uncertain) && (
          <div
            className={editing ? "lares-editor-actions lares-save-bar" : "lares-editor-actions"}
            data-dirty={(editing && dirty) || undefined}
          >
            {editing && (
              <span className="lares-muted">
                {dirty ? "Unsaved changes" : "No unsaved changes"}
              </span>
            )}
            {!editing && step > 0 && (
              <Button
                variant="outline"
                type="button"
                onClick={() => setStep(step - 1)}
              >
                Back
              </Button>
            )}
            {!editing && step < 2 ? (
              <Button
                key="continue-step"
                type="button"
                disabled={
                  step === 1 &&
                  (Boolean(validation) || !validName || !validModel)
                }
                onClick={(event) => {
                  event.preventDefault();
                  setStep(step + 1);
                }}
              >
                Continue →
              </Button>
            ) : (
              <Button
                key="save-agent"
                type="submit"
                disabled={
                  Boolean(validation) ||
                  !validName ||
                  !validModel ||
                  (!editing && !p.capacity.creationAvailable)
                }
              >
                {editing
                  ? "Save definition"
                  : creating === "working"
                    ? "Creating…"
                    : "Create agent"}
              </Button>
            )}
          </div>
          )}
        </FieldGroup>
      </form>
      {editing && feedback}
      {editing && active && <AvatarEditor name={definition.name} role={definition.role ?? ""} initialVersion={p.initial?.avatarVersion} />}
      {editing && active && p.initial && (
        <DoorSetup
          name={p.initial.definition.name}
          display={p.initial.definition.display ?? p.initial.definition.name}
          role={p.initial.definition.role ?? point.id}
          origin={p.publicDoorOrigin ?? ""}
          hash={hash}
          onDefinitionChanged={(next) => {
            setHash(next);
            setUncertain(true);
          }}
          onRuntimeChanged={() => {
            // Re-read, never assume: an unreadable state shows as unavailable rather than as the old "Running".
            void agentRuntime(p.initial!.definition.name)
              .then((read) => setRuntime(read.ok ? read.result : undefined))
              .catch(() => setRuntime(undefined));
          }}
        />
      )}
      {!editing && creating !== "idle" && (
        <div role="status" aria-live="polite" className="lares-create-progress">
          <ol>
            <li>{CREATE_STEPS[0]}{creating === "done" ? " ✓" : creating === "working" ? "…" : ""}</li>
            <li>{CREATE_STEPS[1]}{creating === "done" ? " ✓" : creating === "working" ? "…" : ""}</li>
            <li>{CREATE_STEPS[2]}{creating === "done" ? " ✓" : ""}</li>
          </ol>
          {creating === "working" && <p>{CREATE_WORKING}</p>}
          {creating === "done" && <p>{CREATE_DONE}</p>}
          {creating === "failed" && <p>{CREATE_FAILED}</p>}
        </div>
      )}
      {!editing && feedback}
      {!editing && uncertain && (
        <p>
          <a href={`/agents/${encodeURIComponent(definition.name)}/edit`}>
            Reload this agent’s current state
          </a>
        </p>
      )}
      {editing && (
        <section className="lares-surface">
          <h2>Agent lifecycle</h2>
          <p>
            Retiring preserves its workflow data. Deleting removes its owned
            data and requires confirmation.
          </p>
          {active && (
            <Button
              variant="outline"
              type="button"
              disabled={busy || uncertain || dirty}
              onClick={() => setRetireConfirm(true)}
            >
              Retire agent
            </Button>
          )}
          <Button
            variant="outline"
            type="button"
            disabled={busy || uncertain || dirty}
            onClick={() => {
              setConfirmationName("");
              setDeleteConfirm(true);
            }}
          >
            Delete agent…
          </Button>
          {dirty && (
            <p>
              Save your definition changes before changing the agent lifecycle.
            </p>
          )}
          <Dialog
            open={retireConfirm || deleteConfirm}
            onOpenChange={(open) => {
              if (!open && !busy) {
                setRetireConfirm(false);
                setDeleteConfirm(false);
              }
            }}
          >
            <DialogContent aria-describedby="lifecycle-description">
              <DialogTitle>
                {deleteConfirm ? "Delete agent permanently" : "Retire agent"}
              </DialogTitle>
              <DialogDescription id="lifecycle-description">
                {deleteConfirm
                  ? "This removes the agent and its owned data. It cannot be undone."
                  : "This stops the agent and preserves its workflow data."}
              </DialogDescription>
              {deleteConfirm && (
                <Field label={<>Type {definition.name} to confirm</>}>
                  <Input
                    value={confirmationName}
                    onChange={(e) => setConfirmationName(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              )}
              <div className="lares-actions">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setRetireConfirm(false);
                    setDeleteConfirm(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={
                    busy ||
                    uncertain ||
                    (deleteConfirm && confirmationName !== definition.name)
                  }
                  onClick={() =>
                    void run(async () => {
                      if (deleteConfirm) {
                        const response = await deleteAgent({
                          name: definition.name,
                          confirm: true,
                        });
                        if (!response.ok)
                          throw Object.assign(
                            new Error(response.error.message),
                            {
                              outcomeMayBeUnknown:
                                response.error.outcomeMayBeUnknown,
                            },
                          );
                        setDeleteConfirm(false);
                        router.push("/agents");
                      } else {
                        const response = await retireAgent({
                          name: definition.name,
                        });
                        if (!response.ok)
                          throw Object.assign(
                            new Error(response.error.message),
                            {
                              outcomeMayBeUnknown:
                                response.error.outcomeMayBeUnknown,
                            },
                          );
                        setMessage(
                          `Agent retired.${response.result.backup.ok ? "" : ` ${response.result.backup.message ?? "Git backup failed; the agent remains retired."}`}`,
                        );
                        setRetireConfirm(false);
                        setUncertain(true);
                        router.refresh();
                      }
                    })
                  }
                >
                  {busy
                    ? "Working…"
                    : deleteConfirm
                      ? "Delete permanently"
                      : "Retire agent"}
                </Button>
              </div>
              {error && <p role="alert">{error}</p>}
            </DialogContent>
          </Dialog>
        </section>
      )}
      <Dialog
        open={leaveTo !== null}
        onOpenChange={(open) => {
          if (!open) setLeaveTo(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Leave unsaved changes?</DialogTitle>
          <DialogDescription>
            Your definition changes have not been saved. Immediate permission
            changes remain saved.
          </DialogDescription>
          <div className="lares-actions">
            <Button variant="outline" onClick={() => setLeaveTo(null)}>
              Keep editing
            </Button>
            <Button
              onClick={() => {
                const target = leaveTo;
                setSavedSnapshot(snapshot);
                setLeaveTo(null);
                if (target) router.push(target);
              }}
            >
              Discard changes and leave
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
  return editing ? (
    content
  ) : (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open || busy) return;
        if (dirty && !uncertain) setLeaveTo("/agents");
        else router.push("/agents");
      }}
    >
      <DialogContent
        className="lares-create-dialog"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogTitle>Create an agent</DialogTitle>
        <DialogDescription>
          A purpose, a name, and a clear set of permissions.
        </DialogDescription>
        {content}
      </DialogContent>
    </Dialog>
  );
}
