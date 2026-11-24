import React, { type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from "./icons";

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
/** The one page frame: same left edge everywhere, wide for tables and lists, narrow for forms, settings and chat. */
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

const NOTICE_ICON: Record<NoticeTone, ReactNode> = {
  info: <Info aria-hidden="true" />,
  working: <LoaderCircle aria-hidden="true" />,
  success: <CircleCheck aria-hidden="true" />,
  "needs-you": <TriangleAlert aria-hidden="true" />,
  error: <CircleAlert aria-hidden="true" />,
};

/** A message in one of five tones. `error` is shorthand for tone="error". Only an error is announced as an alert; the rest are quiet status text. */
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
    <div
      className="lares-notice"
      data-tone={kind}
      data-error={kind === "error" || undefined}
      role={kind === "error" ? "alert" : "status"}
    >
      <span className="lares-notice-icon">{NOTICE_ICON[kind]}</span>
      <div className="lares-notice-body">{children}</div>
    </div>
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
