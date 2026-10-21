import "./utilities.css";
import "@lares/ui/console.css";
import { themeScript } from "../lib/theme";
import "./globals.css";
import { signedInMember, isConsoleOwner } from "../lib/auth";
import { AppShell } from "../components/AppShell";
export const metadata = { title: "Lares Console" };
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const member=await signedInMember();
  return (
    <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeScript}}/></head><body>
      <AppShell owner={!!member && isConsoleOwner(member)}>{children}</AppShell>
    </body></html>
  );
}
