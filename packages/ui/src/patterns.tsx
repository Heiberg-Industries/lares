import React, { type ReactNode } from "react";

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
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className="lares-notice"
      data-error={error || undefined}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function StatusBadge({
  children,
  tone = "quiet",
}: {
  children: ReactNode;
  tone?: "quiet" | "attention" | "success" | "error";
}) {
  return (
    <span className="lares-status" data-tone={tone}>
      <span aria-hidden="true" />
      {children}
    </span>
  );
}
