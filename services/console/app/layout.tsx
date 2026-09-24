import "./globals.css";
import { AppShell } from "../components/AppShell";
export const metadata = { title: "Lares Console" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><body>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
      <AppShell>{children}</AppShell>
    </body></html>
  );
}
