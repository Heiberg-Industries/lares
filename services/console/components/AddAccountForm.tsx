"use client";

export function AddAccountForm() {
  return (
    <form
      method="POST"
      action="/api/accounts/google/start"
      style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}
    >
      <label className="mono" style={{ fontSize: 13, color: "var(--mist)" }}>
        Connect a Google account:
      </label>
      <input
        name="email"
        type="email"
        required
        placeholder="name@domain.com"
        className="mono"
        style={{ padding: "4px 8px", border: "1px solid var(--rule)", borderRadius: 4, background: "var(--card)", color: "var(--ink)", fontSize: 13 }}
      />
      <button
        type="submit"
        className="mono"
        style={{ padding: "4px 12px", border: "1px solid var(--rule)", borderRadius: 4, background: "var(--signal)", color: "#fff", fontSize: 13, cursor: "pointer" }}
      >
        Connect
      </button>
    </form>
  );
}
