import "./utilities.css";
import "@lares/ui/console.css";
import { themeScript } from "../lib/theme";
import "./globals.css";
import { signedInMember, isConsoleOwner } from "../lib/auth";
import { memberDisplayName } from "../lib/member-name";
import { AppShell } from "../components/AppShell";
export const metadata = { title: "Lares Console" };
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const member=await signedInMember();
  const person=member ? await memberDisplayName(member.id) : null;
  // data-lares="console" is what the console's design values are scoped to (packages/ui/src/console-theme.css).
  return (
    <html lang="en" data-lares="console" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeScript}}/></head><body>
      <AppShell owner={!!member && isConsoleOwner(member)} person={person}>{children}</AppShell>
    </body></html>
  );
}
