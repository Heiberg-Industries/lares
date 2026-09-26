import "./utilities.css";
import "@lares/ui/console.css";
import { themeScript } from "../lib/theme";
import "./globals.css";
import { AppShell } from "../components/AppShell";
export const metadata = { title: "Lares Console" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeScript}}/></head><body>
      <AppShell>{children}</AppShell>
    </body></html>
  );
}
