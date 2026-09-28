import { PageHeader } from "@lares/ui/patterns";
import { TASTE_DOMAINS, type TasteDomain } from "@lares/taste";

import { listAll, type StoredEntry } from "../../lib/taste-store";
import {
  FRESH_DAYS,
  badgeFor,
  detailFor,
  isFiltered,
  matches,
  optionsFor,
  readFilters,
  sortRows,
  type Filters,
} from "../../lib/taste-browse";
import {
  ListCountry,
  PasteImport,
  TakeoutImport,
} from "../../components/TasteImport";
import { PinAudit } from "../../components/PinAudit";
import { DerivePlaceNames } from "../../components/DerivePlaceNames";
import { TasteEntryRow } from "../../components/TasteEntryRow";
import { badgeStyle } from "../../components/FreshBadge";

export const dynamic = "force-dynamic";

const DOMAIN_BLURB: Record<TasteDomain, string> = {
  places: "Places you have saved for later.",
  music: "Playlists and tracks.",
  food: "Dishes and food notes.",
  notes: "Everything else.",
};

const control = {
  padding: "5px 8px",
  fontSize: 13,
  border: "1px solid var(--rule)",
  borderRadius: 3,
  background: "var(--card)",
  color: "var(--ink)",
} as const;

const controlLabel = {
  display: "block",
  fontSize: 11,
  color: "var(--mist)",
  marginBottom: 3,
} as const;

function Facet({
  name,
  label,
  options,
  value,
}: {
  name: string;
  label: string;
  options: string[];
  value: string;
}) {
  return (
    <div>
      <label style={controlLabel} htmlFor={`taste-${name}`}>
        {label}
      </label>
      <select
        id={`taste-${name}`}
        name={name}
        defaultValue={value}
        style={control}
      >
        <option value="">all</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A plain GET form: the filter lives in the URL, so the whole browse view stays a server
 *  component and a filtered view can be bookmarked. No client JS involved. */
function FilterBar({
  filters,
  everything,
}: {
  filters: Filters;
  everything: StoredEntry[];
}) {
  return (
    <form
      method="get"
      className="card"
      style={{
        padding: 12,
        marginTop: 8,
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        alignItems: "flex-end",
      }}
    >
      <Facet
        name="list"
        label="List"
        options={optionsFor(everything, "list")}
        value={filters.list}
      />
      <Facet
        name="city"
        label="City"
        options={optionsFor(everything, "city")}
        value={filters.city}
      />
      <Facet
        name="country"
        label="Country"
        options={optionsFor(everything, "country")}
        value={filters.country}
      />
      <div>
        <label style={controlLabel} htmlFor="taste-q">
          Name contains
        </label>
        <input
          id="taste-q"
          name="q"
          defaultValue={filters.q}
          placeholder="lucali"
          style={control}
        />
      </div>
      <div>
        <label style={controlLabel} htmlFor="taste-sort">
          Sort
        </label>
        <select
          id="taste-sort"
          name="sort"
          defaultValue={filters.sort}
          style={control}
        >
          <option value="navn">name</option>
          <option value="nyeste">newest first</option>
        </select>
      </div>
      <button type="submit" style={{ ...control, cursor: "pointer" }}>
        Show
      </button>
      {isFiltered(filters) && (
        <a href="/taste" style={{ fontSize: 12, paddingBottom: 6 }}>
          Reset
        </a>
      )}
    </form>
  );
}

export default async function TastePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = readFilters(await searchParams);
  const store = listAll();
  const everything = TASTE_DOMAINS.flatMap((d) => store[d]);
  const total = everything.length;
  const now = Date.now();
  const filtered = isFiltered(filters);

  const shown = Object.fromEntries(
    TASTE_DOMAINS.map((d) => [
      d,
      sortRows(
        store[d].filter((s) => matches(s, filters)),
        filters.sort,
      ),
    ]),
  ) as Record<TasteDomain, StoredEntry[]>;
  const matching = TASTE_DOMAINS.reduce((n, d) => n + shown[d].length, 0);

  return (
    <div className="lares-page lares-operational">
      <PageHeader
        title="Preferences"
        description="Places, music and preferences your agents can draw on."
      />
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        Your saved preferences live on this installation. The console writes
        them; agents can read them. Nothing syncs automatically.
      </p>

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        What is saved
      </h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        {filtered
          ? `${matching} of ${total} entries`
          : `${total} entries`}
        . <span style={badgeStyle}>new</span> or{" "}
        <span style={badgeStyle}>changed</span> means touched by an import in
        the last {FRESH_DAYS} days.
      </p>

      <FilterBar filters={filters} everything={everything} />

      {filtered && matching === 0 && (
        <p
          className="mono"
          style={{ color: "var(--mist)", fontSize: 12, marginTop: 12 }}
        >
          No entries match these filters. {total} saved in total.
        </p>
      )}

      {TASTE_DOMAINS.map((domain) => (
        <section key={domain} style={{ marginTop: 16 }}>
          <h3 className="mono" style={{ fontSize: 13 }}>
            {domain}{" "}
            <span style={{ color: "var(--mist)" }}>
              ·{" "}
              {filtered
                ? `${shown[domain].length} of ${store[domain].length}`
                : store[domain].length}
            </span>
          </h3>
          <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 2 }}>
            {DOMAIN_BLURB[domain]}
          </p>
          {shown[domain].length === 0 ? (
            <p
              className="mono"
              style={{ color: "var(--mist)", fontSize: 12, marginTop: 6 }}
            >
              {store[domain].length === 0
                ? "Nothing saved yet"
                : "Nothing matches these filters"}
            </p>
          ) : (
            <table className="card" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th></th>
                  <th>File</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown[domain].map((stored) => (
                  <TasteEntryRow
                    key={stored.file}
                    domain={domain}
                    file={stored.file}
                    name={stored.entry?.name ?? stored.file}
                    detail={detailFor(stored)}
                    badge={badgeFor(stored.entry, now)}
                    broken={stored.error}
                  />
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
      <details className="lares-disclosure">
        <summary>Add or import preferences</summary>{" "}
        <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
          Google Maps lists
        </h2>
        <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
          Download your saved lists from Google Takeout and import the CSV.
          Coordinates are read from the links locally. Importing the same list
          again updates its entries.
        </p>
        <TakeoutImport />
        <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
          Paste a list
        </h2>
        <PasteImport />
      </details>
      <details className="lares-disclosure">
        <summary>Maintain saved places</summary>{" "}
        <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
          Fill in city and country
        </h2>
        <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
          Derive city and country from saved coordinates offline. New imports
          receive them automatically. Your manual edits are preserved.
        </p>
        <DerivePlaceNames />
        <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
          Set a list's country
        </h2>
        <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
          Set the country on older lists without importing their CSV again.
          Other fields stay as they are.
        </p>
        <ListCountry lists={optionsFor(everything, "list")} />
        <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
          Check coordinates
        </h2>
        <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
          Compare each saved pin with its source link. A distant pin may point
          to a place with the same name in another city; review it here.
        </p>
        <PinAudit />
      </details>
    </div>
  );
}
