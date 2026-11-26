import { Input } from "@lares/ui/primitives/input";
import { Select } from "@lares/ui/primitives/select";
import { requireConsolePage } from "../../lib/auth";
import { EmptyState, Field, Notice, PageHeader, StatusBadge, Page } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
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
    <Field label={label}>
      <Select name={name} defaultValue={value}>
        <option value="">all</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </Field>
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
    <form method="get" className="lares-inline-form">
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
      <Field label="Name contains">
        <Input name="q" defaultValue={filters.q} placeholder="Search names" />
      </Field>
      <Field label="Sort">
        <Select name="sort" defaultValue={filters.sort}>
          <option value="navn">name</option>
          <option value="nyeste">newest first</option>
        </Select>
      </Field>
      <Button type="submit" variant="outline">Show</Button>
      {isFiltered(filters) && (
        <Button variant="ghost" asChild><a href="/saved-preferences">Reset</a></Button>
      )}
    </form>
  );
}

export default async function TastePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireConsolePage();
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
    <Page>
      <PageHeader
        title="Saved preferences"
        description="Places, music and preferences your agents can draw on."
      />
      <p className="lares-note">
        Your saved preferences live on this installation. The console writes
        them; agents can read them. Nothing syncs automatically.
      </p>

      {total === 0 ? (
        <EmptyState title="Nothing saved yet">
          Add a list or import saved places to give your agents preferences they can read.
        </EmptyState>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>What is saved</CardTitle>
            <CardDescription>
              {filtered
                ? `${matching} of ${total} entries`
                : `${total} entries`}
              . <StatusBadge>New</StatusBadge> or{" "}
              <StatusBadge>Changed</StatusBadge> means touched by an import in
              the last {FRESH_DAYS} days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FilterBar filters={filters} everything={everything} />
          </CardContent>
        </Card>
      )}

      {filtered && matching === 0 && (
        <Notice>
          No entries match these filters. {total} saved in total.
        </Notice>
      )}

      {total > 0 && TASTE_DOMAINS.map((domain) => (
        <Card key={domain}>
          <CardHeader>
            <CardTitle role="heading" aria-level={3}>
              {domain}{" "}
              <span className="lares-muted">
                ·{" "}
                {filtered
                  ? `${shown[domain].length} of ${store[domain].length}`
                  : store[domain].length}
              </span>
            </CardTitle>
            <CardDescription>{DOMAIN_BLURB[domain]}</CardDescription>
          </CardHeader>
          {shown[domain].length === 0 ? (
            <CardContent>
              <span className="lares-muted">
                {store[domain].length === 0
                  ? "Nothing saved yet"
                  : "Nothing matches these filters"}
              </span>
            </CardContent>
          ) : (
            <div className="lares-table-scroll"><table>
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
            </table></div>
          )}
        </Card>
      ))}
      <details className="lares-disclosure" open={total === 0}>
        <summary>Add or import preferences</summary>
        <div className="lares-stack">
          <section className="lares-stack">
            <h2 className="lares-section-title">Google Maps lists</h2>
            <p className="lares-note">
              Download your saved lists from Google Takeout and import the CSV.
              Coordinates are read from the links locally. Importing the same list
              again updates its entries.
            </p>
            <TakeoutImport />
          </section>
          <section className="lares-stack">
            <h2 className="lares-section-title">Paste a list</h2>
            <PasteImport />
          </section>
        </div>
      </details>
      <details className="lares-disclosure">
        <summary>Maintain saved places</summary>
        <div className="lares-stack">
          <section className="lares-stack">
            <h2 className="lares-section-title">Fill in city and country</h2>
            <p className="lares-note">
              Derive city and country from saved coordinates offline. New imports
              receive them automatically. Your manual edits are preserved.
            </p>
            <DerivePlaceNames />
          </section>
          <section className="lares-stack">
            <h2 className="lares-section-title">Set a list&apos;s country</h2>
            <p className="lares-note">
              Set the country on older lists without importing their CSV again.
              Other fields stay as they are.
            </p>
            <ListCountry lists={optionsFor(everything, "list")} />
          </section>
          <section className="lares-stack">
            <h2 className="lares-section-title">Check coordinates</h2>
            <p className="lares-note">
              Compare each saved pin with its source link. A distant pin may point
              to a place with the same name in another city; review it here.
            </p>
            <PinAudit />
          </section>
        </div>
      </details>
    </Page>
  );
}
