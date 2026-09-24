import Link from "next/link";
const items = [
  { href: "/chat", label: "Chat" },
  { href: "/", label: "Fleet" },
  { href: "/activity", label: "Activity" },
  { href: "/signals", label: "Signals" },
  { href: "/integrations", label: "Integrations & Accounts" },
  { href: "/voice", label: "Voice" },
  { href: "/proactivity", label: "Proactivity" },
  { href: "/deadlines", label: "Deadlines" },
  { href: "/backup", label: "Backup" },
  { href: "/meetings", label: "Meetings" },
  { href: "/taste", label: "Taste" },
  { href: "/markets", label: "Markets" },
];
export function Nav() {
  return (
    <nav style={{ width: 200, borderRight: "1px solid var(--rule)", padding: 16 }}>
      <div className="mono" style={{ fontWeight: 600, marginBottom: 20 }}>lares</div>
      {items.map((i) => (
        <Link key={i.href} href={i.href} className="mono"
          style={{ display: "block", padding: "6px 0", color: "var(--ink)", fontSize: 13 }}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
