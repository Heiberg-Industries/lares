import React, { type ReactNode } from "react";
import { Check, LoaderCircle } from "./icons";
import { Alert } from "./primitives/alert";
import { Badge } from "./primitives/badge";

export function Mark() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="8.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray="50.5 2.9"
        transform="rotate(-93 12 12)"
      />
      <g fill="currentColor">
        <circle cx="12" cy="20.5" r="1.9" />
        <circle cx="4.64" cy="7.75" r="1.9" />
        <circle cx="19.36" cy="7.75" r="1.9" />
        <circle cx="12" cy="3.5" r="1.1" />
      </g>
    </svg>
  );
}
export function HomeIcon() {
  return (
    <svg
      width="17"
      height="18"
      viewBox="0 0 16 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M2 22V8L8 2l6 6v14" />
    </svg>
  );
}
/** Shared geometric identity with an optional application-owned image URL. */
export function AgentAvatar({ role, src }: { role: string; src?: string }) {
  if (src) return <span className="lares-avatar" aria-hidden="true"><img src={src} alt="" width={40} height={40} /></span>;
  const travel = /travel/i.test(role);
  const chief = /chief/i.test(role);
  const nodes = chief
    ? [
        [20, 32],
        [9.6, 14],
        [30.4, 14],
      ]
    : [
        [20, 8],
        [32, 20],
        [20, 32],
        [8, 20],
      ];
  return (
    <span className="lares-avatar" aria-hidden="true">
      <svg
        viewBox="0 0 40 40"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        {travel ? (
          <>
            <circle
              cx="20"
              cy="20"
              r="12"
              strokeDasharray="60 16"
              transform="rotate(-60 20 20)"
            />
            <circle cx="32" cy="20" r="2.3" fill="currentColor" stroke="none" />
            <path d="M8 20h11" />
          </>
        ) : (
          <>
            <circle cx="20" cy="20" r="12" />
            {nodes.map(([cx, cy]) => (
              <circle
                key={`${cx}-${cy}`}
                cx={cx}
                cy={cy}
                r="2.3"
                fill="currentColor"
                stroke="none"
              />
            ))}
          </>
        )}
      </svg>
    </span>
  );
}
/** The one page frame and its grid: twelve columns with one gutter (four columns on a phone). A child spans
    every column unless it is a Col, or carries a lares-col-* class. `width` is kept for the pages that pass it;
    both widths are the one page width now, and a narrower block is a Col. */
export function Page({
  width = "wide",
  className,
  children,
}: {
  width?: "wide" | "narrow";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={className ? `lares-page ${className}` : "lares-page"}
      data-width={width}
    >
      {children}
    </div>
  );
}
/** How many of the twelve columns a block takes. On a phone every span fills the row, except 3, which takes half. */
export type ColSpan = 12 | 8 | 6 | 4 | 3;
/** A block on the page grid. Use it directly inside Page, instead of giving a section a width. */
export function Col({
  span,
  className,
  children,
}: {
  span: ColSpan;
  className?: string;
  children: ReactNode;
}) {
  return <div className={className ? `lares-col-${span} ${className}` : `lares-col-${span}`}>{children}</div>;
}
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="lares-page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="lares-actions">{actions}</div>}
    </header>
  );
}
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="lares-empty">
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
/** What a notice is telling the person. Each tone has one colour and one icon, so a glance says which kind it is. */
export type NoticeTone = "info" | "working" | "success" | "needs-you" | "error";

// One round icon per tone. Warning ("needs-you") is "!", error is "×"; the stylesheet gives each its colour.
const NOTICE_ICON: Record<NoticeTone, ReactNode> = {
  info: "i",
  working: <LoaderCircle aria-hidden="true" />,
  success: <Check aria-hidden="true" />,
  "needs-you": "!",
  error: "×",
};

/** A message in one of five tones. `needs-you` is the one warning look (amber, "!") and `error` the one error
    look (red, "×"). `error` is shorthand for tone="error". Only an error is announced as an alert; the rest are quiet status text. */
export function Notice({
  children,
  tone,
  error = false,
}: {
  children: ReactNode;
  tone?: NoticeTone;
  error?: boolean;
}) {
  const kind: NoticeTone = tone ?? (error ? "error" : "info");
  return (
    <Alert
      className="lares-notice"
      variant={kind === "error" ? "destructive" : kind === "needs-you" ? "warning" : kind === "success" ? "success" : "default"}
      data-tone={kind}
      data-error={kind === "error" || undefined}
      role={kind === "error" ? "alert" : "status"}
    >
      <span className="lares-notice-icon" aria-hidden="true">{NOTICE_ICON[kind]}</span>
      <div className="lares-notice-body">{children}</div>
    </Alert>
  );
}
/** A list of plain rows. Put it straight inside a Card: each row is at least one row height, with a line between rows. */
export function Rows({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <ul className="lares-rows" aria-label={label}>
      {children}
    </ul>
  );
}
/** One row: a title, an optional line of secondary text, and room on the right for a control or a badge. */
export function Row({
  title,
  description,
  control,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="lares-row">
      <div className="lares-row-main">
        <span className="lares-row-title">{title}</span>
        {description && <p className="lares-row-description">{description}</p>}
        {children}
      </div>
      {control && <div className="lares-row-control">{control}</div>}
    </li>
  );
}
/** A list of tools an agent can use, one ToolRow each. */
export function ToolList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="lares-tool-list" aria-label={label}>
      {children}
    </ul>
  );
}
const TOOL_KIND_WORDS = { read: "Looks things up", change: "Changes something" } as const;
/** One tool: its name, a kind badge, a short description that opens to the full text, and room for a control on the right (a Switch) and for extras underneath. */
export function ToolRow({
  name,
  kind,
  description,
  control,
  children,
}: {
  name: string;
  kind?: "read" | "change";
  description?: string;
  control?: ReactNode;
  children?: ReactNode;
}) {
  const long = (description?.length ?? 0) > 120 || (description ?? "").includes("\n");
  return (
    <li className="lares-tool-row">
      <div className="lares-tool-main">
        <div className="lares-tool-head">
          <strong className="lares-tool-name">{name}</strong>
          {kind && (
            <span className="lares-kind-badge" data-kind={kind}>
              {TOOL_KIND_WORDS[kind]}
            </span>
          )}
        </div>
        {description &&
          (long ? (
            <details className="lares-tool-description">
              <summary>{description.split("\n")[0]!.slice(0, 120)}…</summary>
              <p>{description}</p>
            </details>
          ) : (
            <p className="lares-tool-description">{description}</p>
          ))}
        {children}
      </div>
      {control && <div className="lares-tool-control">{control}</div>}
    </li>
  );
}
export function StatusBadge({
  children,
  tone = "quiet",
  title,
}: {
  children: ReactNode;
  tone?: "quiet" | "attention" | "success" | "error";
  title?: string;
}) {
  return (
    <span className="lares-status" data-tone={tone} title={title}>
      <span aria-hidden="true" />
      {children}
    </span>
  );
}
/** Where a piece of background work is: asked for, waiting, running, finished, failed, or skipped. */
export type RunState = "requested" | "waiting" | "running" | "finished" | "failed" | "skipped";

/** Each state's word, its badge colour, its sentence when nothing more is known, and whether the work is
    still on its way (a page keeps itself up to date while it is). The words match the console's state
    vocabulary (`services/console/lib/state-colours.ts`) where the two share a state. */
export const RUN_STATES: Record<RunState, {
  label: string;
  variant: "info" | "warning" | "success" | "error" | "neutral";
  sentence: string;
  active: boolean;
}> = {
  requested: { label: "Requested", variant: "info", sentence: "Asked for. It starts within a minute or two.", active: true },
  waiting: { label: "Waiting", variant: "warning", sentence: "Not started yet.", active: true },
  running: { label: "Running", variant: "info", sentence: "Working on it now.", active: true },
  finished: { label: "Finished", variant: "success", sentence: "Finished.", active: false },
  failed: { label: "Failed", variant: "error", sentence: "It did not finish.", active: false },
  skipped: { label: "Skipped", variant: "warning", sentence: "It did not run.", active: false },
};

/** True while the work is asked for, waiting or running: the states a page keeps polling for. */
export function runStateIsActive(state: RunState | null | undefined): boolean {
  return state ? RUN_STATES[state].active : false;
}

/** What `RunStatus` shows. Everything but `state` is optional; each is already written for people. */
export interface RunStatusProps {
  state: RunState;
  /** When it finished, failed or was skipped, already formatted ("today at 14:03"). */
  when?: string;
  /** Why it failed or was skipped, or what is happening now, as a plain sentence. */
  why?: string;
  /** The switch or setting that fixes a skip (or a failure), as a link. */
  fix?: { href: string; label: string };
  /** What the work is, for screen readers ("Learning from Sent mail"). */
  label?: string;
}

/** One line that says where a piece of background work is, in plain words: a badge with the state, a
    sentence, and, when something must be switched on or chosen first, a link to where that is done. */
export function RunStatus({ state, when, why, fix, label }: RunStatusProps) {
  const s = RUN_STATES[state];
  const lead = when && (state === "finished" || state === "failed" || state === "skipped")
    ? { finished: `Finished ${when}.`, failed: `Failed ${when}.`, skipped: `Did not run ${when}.` }[state]
    : why && (state === "failed" || state === "skipped") ? "" : s.sentence;
  const text = [lead, why].filter(Boolean).join(" ");
  return (
    <div className="lares-run-status" data-state={state} role="status" aria-live="polite" aria-label={label ? `${label}: ${s.label}` : undefined}>
      <Badge variant={s.variant}>{s.label}</Badge>
      {text && <span className="lares-run-status-text">{text}</span>}
      {fix && <a className="lares-run-status-fix" href={fix.href}>{fix.label}</a>}
    </div>
  );
}
/** A labelled control. The label wraps the control, so clicking the words focuses it. */
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="lares-field-label">
      {label}
      {children}
      {hint && <span className="lares-field-hint">{hint}</span>}
    </label>
  );
}
/** One Checkbox or Radio with its words beside it. */
export function Choice({ children }: { children: ReactNode }) {
  return <label className="lares-choice">{children}</label>;
}
/** A named group of related controls. */
export function FieldGroup({
  legend,
  disabled,
  children,
}: {
  legend: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className="lares-fieldset" disabled={disabled}>
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}
