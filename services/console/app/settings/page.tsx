import Link from "next/link";
import { PageHeader } from "@lares/ui/patterns";
const sections = [
  {
    href: "/proactivity",
    title: "Notifications & quiet hours",
    text: "Shared delivery defaults and recurring work.",
  },
  {
    href: "/backup",
    title: "Backup & recovery",
    text: "Backup configuration, recorded status and recovery guidance.",
  },
  {
    href: "/voice",
    title: "Email writing style",
    text: "Shared defaults and mailbox-specific writing preferences.",
  },
  {
    href: "/signals/rules",
    title: "Alert routing",
    text: "Rules for signals, channels and escalation.",
  },
];
export default function SettingsPage() {
  return (
    <div className="lares-page">
      <PageHeader
        title="Settings"
        description="Shared controls for this installation. Agent instructions and model choices stay with each agent."
      />
      <div className="lares-grid">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="lares-surface lares-link-card"
          >
            <h2 className="lares-section-title">{s.title} →</h2>
            <p>{s.text}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
