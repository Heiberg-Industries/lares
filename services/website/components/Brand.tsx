export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" strokeDasharray="50.5 2.9" transform="rotate(-93 12 12)" />
      <g fill="currentColor">
        <circle cx="12" cy="20.5" r="1.9" />
        <circle cx="4.64" cy="7.75" r="1.9" />
        <circle cx="19.36" cy="7.75" r="1.9" />
        <circle cx="12" cy="3.5" r="1.1" />
      </g>
    </svg>
  );
}

export function Bracket() {
  return (
    <svg width="12" height="18" viewBox="0 0 16 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 22V8L8 2l6 6v14" />
    </svg>
  );
}

export function Brand() {
  return <span className="brand"><Mark /><span>lares</span></span>;
}
