"use client";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  commitPaste,
  commitTakeout,
  previewTakeout,
  setListCountry,
  type CommitResult,
  type CountryResult,
  type ListPreview,
  type UploadedList,
} from "../app/actions/taste";

const label = { display: "block", fontSize: 12, color: "var(--mist)", marginBottom: 4 } as const;
const field = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  border: "1px solid var(--rule)",
  borderRadius: 3,
  background: "transparent",
  color: "var(--ink)",
} as const;
const button = {
  padding: "6px 12px",
  fontSize: 13,
  border: "1px solid var(--rule)",
  borderRadius: 3,
  background: "transparent",
  color: "var(--ink)",
  cursor: "pointer",
} as const;

/**
 * Google Maps saved lists. A re-upload is a DIFF of that list — added, updated, removed — shown
 * per list before anything is written, because "removed" is the change that can surprise: it
 * means Marcel stops recommending a place, so Bendik should see which ones before confirming.
 * Lists not in the batch are never touched.
 */
export function TakeoutImport() {
  const [lists, setLists] = useState<UploadedList[]>([]);
  const [preview, setPreview] = useState<ListPreview[] | null>(null);
  const [results, setResults] = useState<CommitResult[] | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  async function onFiles(files: FileList | null) {
    setPreview(null);
    setResults(null);
    setError("");
    const next: UploadedList[] = [];
    for (const file of Array.from(files ?? [])) {
      next.push({
        // "NYC-resolved.csv" and "NYC.csv" are the same list — the suffix is how the file was
        // produced, not what it is.
        listName: file.name.replace(/\.csv$/i, "").replace(/-resolved$/i, ""),
        csvText: await file.text(),
      });
    }
    setLists(next);
  }

  function edit(i: number, patch: Partial<UploadedList>) {
    setLists((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setPreview(null);
  }

  function run(fn: () => Promise<void>) {
    setError("");
    start(async () => {
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const removedNames = preview?.flatMap((p) => p.removedNames) ?? [];

  return (
    <div className="card" style={{ padding: 12, marginTop: 8 }}>
      <div>
        <label style={label} htmlFor="taste-csv">Takeout-CSV (flere om gangen går fint)</label>
        <input
          id="taste-csv"
          type="file"
          accept=".csv,text/csv"
          multiple
          style={{ ...field, padding: 4 }}
          onChange={(e) => void onFiles(e.target.files)}
        />
      </div>

      {lists.length > 0 && (
        <table className="card" style={{ marginTop: 8 }}>
          <thead><tr><th>Listenavn</th><th>By (valgfritt)</th><th>Land (valgfritt)</th><th></th></tr></thead>
          <tbody>
            {lists.map((l, i) => (
              <tr key={i}>
                <td><input style={field} value={l.listName} onChange={(e) => edit(i, { listName: e.target.value })} /></td>
                <td>
                  <input style={field} value={l.city ?? ""} placeholder="New York"
                    onChange={(e) => edit(i, { city: e.target.value })} />
                </td>
                <td>
                  <input style={field} value={l.country ?? ""} placeholder="USA"
                    onChange={(e) => edit(i, { country: e.target.value })} />
                </td>
                <td style={{ color: "var(--mist)", fontSize: 12 }}>{l.csvText.split("\n").length - 1} rader</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {lists.length > 0 && (
        <button style={{ ...button, marginTop: 8 }} disabled={pending}
          onClick={() => run(async () => setPreview(await previewTakeout({ lists })))}>
          Vis hva som endres
        </button>
      )}

      {error && <p className="mono" style={{ marginTop: 8, fontSize: 12, color: "var(--bad)" }}>✕ {error}</p>}

      {preview && (
        <div style={{ marginTop: 12 }}>
          <table className="card">
            <thead><tr><th>Liste</th><th>+ nye</th><th>~ endret</th><th>− fjernet</th><th>Koordinater</th></tr></thead>
            <tbody>
              {preview.map((p) => (
                <tr key={p.listName}>
                  <td className="mono">{p.listName}</td>
                  <td>{p.added}</td>
                  <td>{p.updated}</td>
                  <td style={p.removed > 0 ? { color: "var(--bad)" } : undefined}>{p.removed}</td>
                  <td style={{ color: "var(--mist)", fontSize: 12 }}>
                    {p.withCoords} fra fila
                    {p.keepsCoords > 0 && `, ${p.keepsCoords} beholdes`}
                    {p.needsLookup > 0 && `, ${p.needsLookup} må slås opp`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {removedNames.length > 0 && (
            <p style={{ fontSize: 12, marginTop: 8, color: "var(--bad)" }}>
              Fjernes helt: {removedNames.slice(0, 12).join(", ")}
              {removedNames.length > 12 && ` … (+${removedNames.length - 12})`}
            </p>
          )}
          <button style={{ ...button, marginTop: 8 }} disabled={pending}
            onClick={() => run(async () => { setResults(await commitTakeout({ lists })); setPreview(null); })}>
            Lagre endringene
          </button>
        </div>
      )}

      {results && <CommitSummary results={results} />}
    </div>
  );
}

/**
 * Country backfill for a list already in the store (ORB-110).
 *
 * The upload form carries country going forward, but 862 places across 25 lists were imported
 * before the field existed, and re-exporting every list from Google Takeout to attach one word
 * each is not a real option. This writes the country onto one list's entries in place.
 *
 * It reports `alreadySet` as well as `changed` on purpose: running it twice must be visibly
 * "nothing left to do", not visibly nothing.
 */
export function ListCountry({ lists }: { lists: string[] }) {
  const [listName, setListName] = useState("");
  const [country, setCountry] = useState("");
  const [result, setResult] = useState<CountryResult | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  if (lists.length === 0) return null;

  return (
    <div className="card" style={{ padding: 12, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ minWidth: 220 }}>
          <label style={label} htmlFor="country-list">Liste</label>
          <select id="country-list" style={field} value={listName}
            onChange={(e) => { setListName(e.target.value); setResult(null); }}>
            <option value="">velg en liste</option>
            {lists.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 160 }}>
          <label style={label} htmlFor="country-value">Land</label>
          <input id="country-value" style={field} value={country} placeholder="Danmark"
            onChange={(e) => { setCountry(e.target.value); setResult(null); }} />
        </div>
        <button
          style={button}
          disabled={pending || listName === "" || country.trim() === ""}
          onClick={() => {
            setError("");
            setResult(null);
            start(async () => {
              try {
                setResult(await setListCountry({ listName, country }));
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            });
          }}
        >
          Sett land
        </button>
        {error && <span className="mono" style={{ fontSize: 12, color: "var(--bad)" }}>✕ {error}</span>}
        {result && (
          <span className="mono" style={{ fontSize: 12, color: "var(--ok)" }}>
            ✓ {result.listName}: {result.changed} oppdatert
            {result.alreadySet > 0 && `, ${result.alreadySet} hadde det alt`}
            {result.changed === 0 && result.alreadySet === 0 && " — listen har ingen oppføringer"}
          </span>
        )}
      </div>
    </div>
  );
}

/** Anything else Bendik has as a list: a playlist, dishes to cook, a restaurant list a friend
 *  sent him. Bulleted, numbered or bare lines all read the same. */
export function PasteImport() {
  const [domain, setDomain] = useState("music");
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function onSave() {
    setError("");
    setMessage("");
    start(async () => {
      try {
        const r = await commitPaste({ domain, name, text, city, country });
        setMessage(`${r.added} nye, ${r.replaced} oppdatert`);
        setText("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="card" style={{ padding: 12, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <label style={label} htmlFor="paste-domain">Hvor</label>
          <select id="paste-domain" style={field} value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="music">music — spillelister, spor</option>
            <option value="food">food — retter, matnotater</option>
            <option value="notes">notes — alt annet</option>
            <option value="places">places — steder (én per linje)</option>
          </select>
        </div>
        <div style={{ minWidth: 200 }}>
          <label style={label} htmlFor="paste-name">Listenavn</label>
          <input id="paste-name" style={field} value={name} placeholder="Sommer 2026"
            onChange={(e) => setName(e.target.value)} />
        </div>
        {domain === "places" && (
          <div style={{ minWidth: 160 }}>
            <label style={label} htmlFor="paste-city">By (valgfritt)</label>
            <input id="paste-city" style={field} value={city} placeholder="New York"
              onChange={(e) => setCity(e.target.value)} />
          </div>
        )}
        {domain === "places" && (
          <div style={{ minWidth: 140 }}>
            <label style={label} htmlFor="paste-country">Land (valgfritt)</label>
            <input id="paste-country" style={field} value={country} placeholder="USA"
              onChange={(e) => setCountry(e.target.value)} />
          </div>
        )}
      </div>
      {domain === "places" && (
        <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 8 }}>
          Limte steder blir én oppføring hver, uten koordinater — sett by, så finner Marcel dem på turen.
        </p>
      )}
      <textarea
        style={{ ...field, marginTop: 8, minHeight: 120, fontFamily: "inherit" }}
        value={text}
        placeholder={"- Nick Drake — Pink Moon\n- Alice Coltrane — Turiya and Ramakrishna"}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ marginTop: 8 }}>
        <button style={button} disabled={pending || text.trim() === "" || name.trim() === ""} onClick={onSave}>
          Lagre
        </button>
        {error && <span className="mono" style={{ marginLeft: 12, fontSize: 12, color: "var(--bad)" }}>✕ {error}</span>}
        {message && <span className="mono" style={{ marginLeft: 12, fontSize: 12, color: "var(--good, #2a7)" }}>✓ {message}</span>}
      </div>
    </div>
  );
}

/**
 * What a commit did, where it cannot be missed.
 *
 * ORB-116: Bendik's first real 26-list upload committed perfectly and he could not tell, because
 * the result rendered below a 26-row table — off the bottom of the screen. So this scrolls itself
 * into view on mount and states the totals first; the per-list breakdown is underneath for anyone
 * who wants it. The counts are deliberately blunt about the boring case too ("ingen var endret"),
 * because silence there reads exactly like a failure to save.
 */
function CommitSummary({ results }: { results: CommitResult[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const sum = (pick: (r: CommitResult) => number) => results.reduce((n, r) => n + pick(r), 0);
  const approximate = results.flatMap((r) => r.approximate);
  const unresolved = results.flatMap((r) => r.unresolved);
  const [showApprox, setShowApprox] = useState(false);

  return (
    <div
      ref={ref}
      style={{
        marginTop: 12,
        padding: "10px 12px",
        border: "1px solid var(--ok)",
        borderRadius: 3,
        background: "color-mix(in srgb, var(--ok) 8%, transparent)",
      }}
    >
      <p className="mono" style={{ fontSize: 13, color: "var(--ok)" }}>
        ✓ Lagret {results.length} {results.length === 1 ? "liste" : "lister"}: +{sum((r) => r.added)} nye,{" "}
        ~{sum((r) => r.changed)} endret, −{sum((r) => r.removed)} fjernet
        {sum((r) => r.geocoded) > 0 && `, ${sum((r) => r.geocoded)} slått opp`}
        {approximate.length > 0 && `, ${approximate.length} omtrentlige`}
        {unresolved.length > 0 && `, ${unresolved.length} uten koordinater`}
      </p>

      {results.map((r) => (
        <p key={r.listName} className="mono" style={{ fontSize: 12, marginTop: 4, color: "var(--mist)" }}>
          {r.listName}: +{r.added} ~{r.updated} −{r.removed}
          {r.updated > 0 && (r.changed > 0
            ? ` · ${r.changed} av ${r.updated} var faktisk endret`
            : ` · ingen av de ${r.updated} var endret`)}
          {r.keptCoordinates > 0 && ` · ${r.keptCoordinates} beholdt koordinater`}
          {r.geocoded > 0 && ` · ${r.geocoded} slått opp`}
        </p>
      ))}

      {approximate.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={() => setShowApprox((v) => !v)}
            style={{ ...button, padding: "2px 8px", fontSize: 12 }}
          >
            {showApprox ? "Skjul" : "Vis"} de {approximate.length} omtrentlige
          </button>
          {showApprox && (
            <p style={{ fontSize: 12, marginTop: 4, color: "var(--mist)" }}>
              Plassert fra lenken sin egen posisjon, ikke bekreftet med treff:{" "}
              {approximate.map((u) => `${u.name} (${u.reason})`).join(", ")}
            </p>
          )}
        </div>
      )}

      {unresolved.length > 0 && (
        <p style={{ fontSize: 12, marginTop: 6, color: "var(--mist)" }}>
          Uten koordinater i det hele tatt (gjettes aldri):{" "}
          {unresolved.slice(0, 12).map((u) => `${u.name} (${u.reason})`).join(", ")}
          {unresolved.length > 12 && ` … (+${unresolved.length - 12})`}
        </p>
      )}
    </div>
  );
}
