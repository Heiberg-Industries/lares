import { EmptyState, PageHeader, StatusBadge } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
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

export const dynamic = "force-dynamic";

const DOMAIN_BLURB: Record<TasteDomain, string> = {
  places: "Places you have saved for later.",
  music: "Playlists and tracks.",
  food: "Dishes and food notes.",
  notes: "Everything else.",
};

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
    <div className="lares-field-label">
      <label htmlFor={`taste-${name}`}>
        {label}
      </label>
      <select
        id={`taste-${name}`}
        name={name}
        defaultValue={value}
        className="lares-field"
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
      className="card lares-inline-form lares-preferences-filter"
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
      <div className="lares-field-label">
        <label htmlFor="taste-q">
          Name contains
        </label>
        <input
          id="taste-q"
          name="q"
          defaultValue={filters.q}
          placeholder="Search names"
          className="lares-field"
        />
      </div>
      <div className="lares-field-label">
        <label htmlFor="taste-sort">
          Sort
        </label>
        <select
          id="taste-sort"
          name="sort"
          defaultValue={filters.sort}
          className="lares-field"
        >
          <option value="navn">name</option>
          <option value="nyeste">newest first</option>
        </select>
      </div>
      <Button type="submit" variant="outline">Show</Button>
      {isFiltered(filters) && (
        <Button variant="ghost" asChild><a href="/taste">Reset</a></Button>
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
      <p className="lares-muted lares-operational-intro">
        Your saved preferences live on this installation. The console writes
        them; agents can read them. Nothing syncs automatically.
      </p>

      <h2>
        What is saved
      </h2>
      <p className="lares-muted lares-operational-intro">
        {filtered
          ? `${matching} of ${total} entries`
          : `${total} entries`}
        . <StatusBadge>New</StatusBadge> or{" "}
        <StatusBadge>Changed</StatusBadge> means touched by an import in
        the last {FRESH_DAYS} days.
      </p>

      {total > 0 && <FilterBar filters={filters} everything={everything} />}

      {total === 0 && (
        <EmptyState title="Nothing saved yet">
          Add a list or import saved places to give your agents preferences they can read.
        </EmptyState>
      )}

      {filtered && matching === 0 && (
        <p className="lares-muted lares-operational-intro">
          No entries match these filters. {total} saved in total.
        </p>
      )}

      {total > 0 && TASTE_DOMAINS.map((domain) => (
        <section key={domain} className="lares-preferences-domain">
          <h3 className="lares-domain-title">
            {domain}{" "}
            <span className="lares-muted">
              ·{" "}
              {filtered
                ? `${shown[domain].length} of ${store[domain].length}`
                : store[domain].length}
            </span>
          </h3>
          <p className="lares-muted lares-operational-intro">
            {DOMAIN_BLURB[domain]}
          </p>
          {shown[domain].length === 0 ? (
            <p className="lares-muted lares-operational-intro">
              {store[domain].length === 0
                ? "Nothing saved yet"
                : "Nothing matches these filters"}
            </p>
          ) : (
            <table className="card lares-operational-table">
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
      <details className="lares-disclosure" open={total === 0}>
        <summary>Add or import preferences</summary>{" "}
        <h2>
          Google Maps lists
        </h2>
        <p className="lares-muted lares-operational-intro">
          Download your saved lists from Google Takeout and import the CSV.
          Coordinates are read from the links locally. Importing the same list
          again updates its entries.
        </p>
        <TakeoutImport />
        <h2>
          Paste a list
        </h2>
        <PasteImport />
      </details>
      <details className="lares-disclosure">
        <summary>Maintain saved places</summary>{" "}
        <h2>
          Fill in city and country
        </h2>
        <p className="lares-muted lares-operational-intro">
          Derive city and country from saved coordinates offline. New imports
          receive them automatically. Your manual edits are preserved.
        </p>
        <DerivePlaceNames />
        <h2>
          Set a list's country
        </h2>
        <p className="lares-muted lares-operational-intro">
          Set the country on older lists without importing their CSV again.
          Other fields stay as they are.
        </p>
        <ListCountry lists={optionsFor(everything, "list")} />
        <h2>
          Check coordinates
        </h2>
        <p className="lares-muted lares-operational-intro">
          Compare each saved pin with its source link. A distant pin may point
          to a place with the same name in another city; review it here.
        </p>
        <PinAudit />
      </details>
    </div>
  );
}
