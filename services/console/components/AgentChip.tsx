export function AgentChip({ name, role }: { name: string; role: string }) {
  return (
    <span className="mono" style={{ fontWeight: 600 }}>
      {name[0].toUpperCase() + name.slice(1)}
      <span style={{ color: "var(--mist)", fontWeight: 400 }}> — {role}</span>
    </span>
  );
}
