"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";

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
        <label className="lares-field-label" htmlFor="taste-csv">Google Takeout CSV files</label>
        <Input
          id="taste-csv"
          type="file"
          accept=".csv,text/csv"
          multiple
          className="lares-field"
          onChange={(e) => void onFiles(e.target.files)}
        />
      </div>

      {lists.length > 0 && (
        <table className="card" style={{ marginTop: 8 }}>
          <thead><tr><th>List name</th><th>City (optional)</th><th>Country (optional)</th><th></th></tr></thead>
          <tbody>
            {lists.map((l, i) => (
              <tr key={i}>
                <td><Input className="lares-field" value={l.listName} onChange={(e) => edit(i, { listName: e.target.value })} /></td>
                <td>
                  <Input className="lares-field" value={l.city ?? ""} placeholder="New York"
                    onChange={(e) => edit(i, { city: e.target.value })} />
                </td>
                <td>
                  <Input className="lares-field" value={l.country ?? ""} placeholder="USA"
                    onChange={(e) => edit(i, { country: e.target.value })} />
                </td>
                <td style={{ color: "var(--mist)", fontSize: 12 }}>{l.csvText.split("\n").length - 1} rows</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {lists.length > 0 && (
        <Button  disabled={pending}
          onClick={() => run(async () => setPreview(await previewTakeout({ lists })))}>
          Preview changes
        </Button>
      )}

      {error && <p className="mono" style={{ marginTop: 8, fontSize: 12, color: "var(--bad)" }}>✕ {error}</p>}

      {preview && (
        <div style={{ marginTop: 12 }}>
          <table className="card">
            <thead><tr><th>List</th><th>+ added</th><th>~ updated</th><th>− removed</th><th>Coordinates</th></tr></thead>
            <tbody>
              {preview.map((p) => (
                <tr key={p.listName}>
                  <td className="mono">{p.listName}</td>
                  <td>{p.added}</td>
                  <td>{p.updated}</td>
                  <td style={p.removed > 0 ? { color: "var(--bad)" } : undefined}>{p.removed}</td>
                  <td style={{ color: "var(--mist)", fontSize: 12 }}>
                    {p.withCoords} from file
                    {p.keepsCoords > 0 && `, ${p.keepsCoords} retained`}
                    {p.needsLookup > 0 && `, ${p.needsLookup} need lookup`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {removedNames.length > 0 && (
            <p style={{ fontSize: 12, marginTop: 8, color: "var(--bad)" }}>
              Removed from these lists: {removedNames.slice(0, 12).join(", ")}
              {removedNames.length > 12 && ` … (+${removedNames.length - 12})`}
            </p>
          )}
          <Button  disabled={pending}
            onClick={() => run(async () => { setResults(await commitTakeout({ lists })); setPreview(null); })}>
            Save changes
          </Button>
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
          <label className="lares-field-label" htmlFor="country-list">List</label>
          <select id="country-list" className="lares-field" value={listName}
            onChange={(e) => { setListName(e.target.value); setResult(null); }}>
            <option value="">Choose a list</option>
            {lists.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 160 }}>
          <label className="lares-field-label" htmlFor="country-value">Country</label>
          <Input id="country-value" className="lares-field" value={country} placeholder="Denmark"
            onChange={(e) => { setCountry(e.target.value); setResult(null); }} />
        </div>
        <Button
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
          Set country
        </Button>
        {error && <span className="mono" style={{ fontSize: 12, color: "var(--bad)" }}>✕ {error}</span>}
        {result && (
          <span className="mono" style={{ fontSize: 12, color: "var(--ok)" }}>
            ✓ {result.listName}: {result.changed} updated
            {result.alreadySet > 0 && `, ${result.alreadySet} already set`}
            {result.changed === 0 && result.alreadySet === 0 && " — this list has no entries"}
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
        setMessage(`${r.added} added, ${r.replaced} updated`);
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
          <label className="lares-field-label" htmlFor="paste-domain">Category</label>
          <select id="paste-domain" className="lares-field" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="music">music — playlists and tracks</option>
            <option value="food">food — dishes and notes</option>
            <option value="notes">notes — everything else</option>
            <option value="places">places — one place per line</option>
          </select>
        </div>
        <div style={{ minWidth: 200 }}>
          <label className="lares-field-label" htmlFor="paste-name">List name</label>
          <Input id="paste-name" className="lares-field" value={name} placeholder="Summer 2026"
            onChange={(e) => setName(e.target.value)} />
        </div>
        {domain === "places" && (
          <div style={{ minWidth: 160 }}>
            <label className="lares-field-label" htmlFor="paste-city">City (optional)</label>
            <Input id="paste-city" className="lares-field" value={city} placeholder="New York"
              onChange={(e) => setCity(e.target.value)} />
          </div>
        )}
        {domain === "places" && (
          <div style={{ minWidth: 140 }}>
            <label className="lares-field-label" htmlFor="paste-country">Country (optional)</label>
            <Input id="paste-country" className="lares-field" value={country} placeholder="USA"
              onChange={(e) => setCountry(e.target.value)} />
          </div>
        )}
      </div>
      {domain === "places" && (
        <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 8 }}>
          Each pasted place becomes one entry without coordinates. Add a city to help your agents find it later.
        </p>
      )}
      <textarea
        className="lares-field lares-preferences-paste"
        value={text}
        placeholder={"- Nick Drake — Pink Moon\n- Alice Coltrane — Turiya and Ramakrishna"}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ marginTop: 8 }}>
        <Button  disabled={pending || text.trim() === "" || name.trim() === ""} onClick={onSave}>
          Save
        </Button>
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
    <div ref={ref} className="lares-result-card">
      <p className="mono" style={{ fontSize: 13, color: "var(--ok)" }}>
        ✓ Saved {results.length} {results.length === 1 ? "list" : "lists"}: +{sum((r) => r.added)} added,{" "}
        ~{sum((r) => r.changed)} changed, −{sum((r) => r.removed)} removed
        {sum((r) => r.geocoded) > 0 && `, ${sum((r) => r.geocoded)} located`}
        {approximate.length > 0 && `, ${approximate.length} approximate`}
        {unresolved.length > 0 && `, ${unresolved.length} without coordinates`}
      </p>

      {results.map((r) => (
        <p key={r.listName} className="mono" style={{ fontSize: 12, marginTop: 4, color: "var(--mist)" }}>
          {r.listName}: +{r.added} ~{r.updated} −{r.removed}
          {r.updated > 0 && (r.changed > 0
            ? ` · ${r.changed} of ${r.updated} actually changed`
            : ` · none of the ${r.updated} changed`)}
          {r.keptCoordinates > 0 && ` · ${r.keptCoordinates} retained coordinates`}
          {r.geocoded > 0 && ` · ${r.geocoded} located`}
        </p>
      ))}

      {approximate.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Button
            type="button"
            onClick={() => setShowApprox((v) => !v)}
            size="sm" variant="outline"
          >
            {showApprox ? "Hide" : "Show"} {approximate.length} approximate locations
          </Button>
          {showApprox && (
            <p style={{ fontSize: 12, marginTop: 4, color: "var(--mist)" }}>
              Placed from the link location without a confirmed match:{" "}
              {approximate.map((u) => `${u.name} (${u.reason})`).join(", ")}
            </p>
          )}
        </div>
      )}

      {unresolved.length > 0 && (
        <p style={{ fontSize: 12, marginTop: 6, color: "var(--mist)" }}>
          No coordinates available (never guessed):{" "}
          {unresolved.slice(0, 12).map((u) => `${u.name} (${u.reason})`).join(", ")}
          {unresolved.length > 12 && ` … (+${unresolved.length - 12})`}
        </p>
      )}
    </div>
  );
}
