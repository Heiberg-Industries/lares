import { BookOpen, Network, Radio, Wrench } from "@lares/ui/icons";

const ICONS = { gateway: Network, readability: BookOpen, signals: Radio, outside: Wrench } as const;
/** Plain data, so a server page can hand it to a client component. */
export type Logo = { kind: "letter"; text: string } | { kind: "microsoft" } | { kind: "icon"; name: keyof typeof ICONS };

/** A small square mark: a letter, the four Microsoft squares or an icon. Nothing is loaded from outside. */
export function LogoTile({ logo, label }: { logo: Logo; label: string }) {
  const Icon = logo.kind === "icon" ? ICONS[logo.name] : null;
  return (
    <span className="lares-logo-tile" role="img" aria-label={label}>
      {logo.kind === "letter" && logo.text}
      {logo.kind === "microsoft" && <span className="lares-logo-ms" aria-hidden="true"><span /><span /><span /><span /></span>}
      {Icon && <Icon aria-hidden="true" />}
    </span>
  );
}
