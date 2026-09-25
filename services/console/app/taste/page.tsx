import { PageHeader } from "@lares/ui/patterns";
import { TASTE_DOMAINS, type TasteDomain } from "@lares/taste";

import { listAll, tasteRoot, type StoredEntry } from "../../lib/taste-store";
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
  places:
    "Steder du har lagret. Marcel finner dem igjen når du er i nærheten på tur.",
  music: "Spillelister og spor.",
  food: "Retter og matnotater.",
  notes: "Alt annet.",
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
        <option value="">alle</option>
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
 *  component and a filtered view is a link Bendik can bookmark. No client JS involved. */
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
        label="Liste"
        options={optionsFor(everything, "list")}
        value={filters.list}
      />
      <Facet
        name="city"
        label="By"
        options={optionsFor(everything, "city")}
        value={filters.city}
      />
      <Facet
        name="country"
        label="Land"
        options={optionsFor(everything, "country")}
        value={filters.country}
      />
      <div>
        <label style={controlLabel} htmlFor="taste-q">
          Navn inneholder
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
          Sortering
        </label>
        <select
          id="taste-sort"
          name="sort"
          defaultValue={filters.sort}
          style={control}
        >
          <option value="navn">navn</option>
          <option value="nyeste">nyeste først</option>
        </select>
      </div>
      <button type="submit" style={{ ...control, cursor: "pointer" }}>
        Vis
      </button>
      {isFiltered(filters) && (
        <a href="/taste" style={{ fontSize: 12, paddingBottom: 6 }}>
          Nullstill
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
        title="Saved preferences"
        description="Places, music and preferences your agents can draw on."
      />
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        Din egen smak, som filer: <span className="mono">{tasteRoot()}</span>.
        Konsollet er det eneste som skriver her — agentene leser bare. Ingenting
        synkroniseres automatisk; det som står her, er det du selv har lagt inn.
      </p>

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Google Maps-lister
      </h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        Last ned de lagrede listene dine fra Google Takeout og legg inn
        CSV-fila. Koordinatene ligger i lenkene — de hentes ut her, ingen
        oppslag utenfor boksen. Laster du opp samme liste på nytt, oppdateres
        oppføringene i stedet for å komme i tillegg.
      </p>
      <TakeoutImport />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Lim inn en liste
      </h2>
      <PasteImport />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Fyll inn by og land
      </h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        Utledes fra koordinatene, offline — du skal ikke måtte skrive «København
        / Danmark» på hver liste. Nye opplastinger får det automatisk; dette er
        for det som alt ligger her. Det du har skrevet inn selv, blir stående.
      </p>
      <DerivePlaceNames />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Sett land på en liste
      </h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        Listene som lå her før land fantes som felt, får det herfra — uten å
        laste opp CSV-ene på nytt. Endrer bare landet; alt annet står urørt.
      </p>
      <ListCountry lists={optionsFor(everything, "list")} />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Sjekk koordinatene
      </h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        Hver lagret lenke sier selv omtrent hvor stedet ligger. Står pinnen et
        helt annet sted enn lenken, er den nesten alltid et likelydende sted i
        en annen by — det skjer når et navn er slått opp i stedet for lenken.
        Her finnes de, og de kan slås opp på nytt.
      </p>
      <PinAudit />

      <h2 className="mono" style={{ fontSize: 14, marginTop: 24 }}>
        Det som ligger der nå
      </h2>
      <p style={{ color: "var(--mist)", fontSize: 12, marginTop: 4 }}>
        {filtered
          ? `${matching} av ${total} oppføringer`
          : `${total} oppføringer i alt`}
        . Merket <span style={badgeStyle}>ny</span> eller{" "}
        <span style={badgeStyle}>endret</span> vil si rørt av en opplasting de
        siste {FRESH_DAYS} dagene.
      </p>

      <FilterBar filters={filters} everything={everything} />

      {filtered && matching === 0 && (
        <p
          className="mono"
          style={{ color: "var(--mist)", fontSize: 12, marginTop: 12 }}
        >
          Ingen oppføringer passer filteret. {total} ligger i butikken.
        </p>
      )}

      {TASTE_DOMAINS.map((domain) => (
        <section key={domain} style={{ marginTop: 16 }}>
          <h3 className="mono" style={{ fontSize: 13 }}>
            {domain}{" "}
            <span style={{ color: "var(--mist)" }}>
              ·{" "}
              {filtered
                ? `${shown[domain].length} av ${store[domain].length}`
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
                ? "tomt"
                : "ingenting som passer filteret"}
            </p>
          ) : (
            <table className="card" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th>Navn</th>
                  <th></th>
                  <th>Fil</th>
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
    </div>
  );
}
