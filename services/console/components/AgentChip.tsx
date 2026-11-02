export function AgentChip({ name, role }: { name: string; role: string }) {
  return (
    <span className="mono">
      <strong>{name[0].toUpperCase() + name.slice(1)}</strong>
      <span className="lares-status-muted"> — {role}</span>
    </span>
  );
}
