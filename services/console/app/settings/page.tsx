import Link from "next/link";
import { PageHeader } from "@lares/ui/patterns";
import { SettingsThemeControl } from "../../components/ThemeControl";
import {
  getProactivityView,
  rowFor,
  effectiveQuietWindow,
} from "../../lib/proactivity";
export const dynamic = "force-dynamic";
export default async function SettingsPage() {
  const view = await getProactivityView().catch(() => null);
  const quiet =
    view && !view.errors.length
      ? (rowFor(view.settings, "*", "*")?.effective.quiet ??
        effectiveQuietWindow(null, null))
      : null;
  return (
    <div className="lares-page lares-settings">
      <PageHeader
        title="Settings"
        description="The shared defaults for your house."
      />
      <div className="lares-stack">
        <section className="lares-surface">
          <h2 className="lares-section-title">Notifications & quiet hours</h2>
          <div className="lares-setting-row">
            <div>
              Quiet hours
              <p>
                {quiet
                  ? `Hold non-urgent updates between ${quiet.quietStart} and ${quiet.quietEnd}.`
                  : "Quiet hours could not be loaded."}
              </p>
            </div>
            <Link href="/proactivity">Manage</Link>
          </div>
          <div className="lares-setting-row">
            <div>
              Time zone<p>Used for schedules and your daily brief.</p>
            </div>
            <span className="mono">{view?.clock.tz ?? "Unavailable"}</span>
          </div>
        </section>
        <section className="lares-surface">
          <h2 className="lares-section-title">Appearance</h2>
          <div className="lares-setting-row">
            <div>
              Color theme<p>Light, dark, or follow your device.</p>
            </div>
            <SettingsThemeControl />
          </div>
        </section>
        <section className="lares-surface">
          <h2 className="lares-section-title">Backup & recovery</h2>
          <p className="lares-muted">
            Review recorded backups and recovery options.
          </p>
          <Link href="/backup">View backup settings →</Link>
        </section>
        <section className="lares-surface">
          <h2 className="lares-section-title">More settings</h2>
          <div className="lares-setting-row">
            <div>
              Email writing style
              <p>Shared defaults and mailbox-specific preferences.</p>
            </div>
            <Link href="/voice">Manage</Link>
          </div>
          <div className="lares-setting-row">
            <div>
              Alert routing<p>Choose channels and escalation rules.</p>
            </div>
            <Link href="/signals/rules">Manage</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
