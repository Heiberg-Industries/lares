import { Nav } from "./Nav";
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Nav />
      <main style={{ flex: 1, padding: 24 }}>{children}</main>
    </div>
  );
}
