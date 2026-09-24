// The tool pool. GENERATED — regenerate with the snippet in the ORB-278 step 2 plan, Task 7.
// Each entry names the capability whose grant decides whether a session gets the tool.
//
// It is a real module and not a glob on purpose: `eve build` bundles what it can see statically,
// and a directory read at runtime would resolve against .output/server/, not this folder.
// `tests/catalogue-index.test.ts` is what keeps it honest — it holds this map against the files
// on disk in both directions, and every capability against `capabilityOfTool`.
//
// TWO THINGS ARE DELIBERATELY NOT HERE.
//
// `web_search` — `agent/tools/web_search.ts` is NOT a `disableTool()` sentinel, it is Marcel's
// one authored FRAMEWORK-tool enable (`framework_tools: ["web_search"]` in agent.json). A
// framework tool is engine policy, not a capability a definition grants — it stays where it is,
// and `tests/catalogue-index.test.ts` asserts it is absent from this map.
//
// Eleven of Marcel's twelve `agent-kit__*` contributions — he grants neither `brain`, `orakel`,
// `markets` nor `signals`, so `agent/extensions/agent-kit/tools/{brain,orakel,market_edge,
// signals_recent,vault}_*.ts` all resolve to `disableTool()` sentinels and contribute nothing to
// his session. `agent-kit__transit_plan` is the ONE exception (ORB-168: he grants `transit` at
// `read`), and it is HERE rather than left to the extension mount — see
// catalogue/agent-kit__transit_plan.ts's own header, and agent/extensions/agent-kit/tools/
// transit_plan.ts's, for why the prefixed key moved. This is the first time in the fleet that
// prefixed-key mechanism (Task 1's Q3) carries real weight rather than being a documented no-op
// (Task 7's report, §6, for Calliope).
import type { Catalogue } from "@lares/agent-kit/catalogue";
import { ALWAYS_PRESENT_CAPABILITY } from "@lares/agent-kit/catalogue";

import agent_kit_transit_plan from "./agent-kit__transit_plan.js";
import calendar_list_events from "./calendar_list_events.js";
import currency_convert from "./currency_convert.js";
import flight_status from "./flight_status.js";
import info from "./info.js";
import link_group from "./link_group.js";
import nearby_places from "./nearby_places.js";
import nytur from "./nytur.js";
import persona_overlay from "./persona_overlay.js";
import place_link from "./place_link.js";
import predeparture_pack from "./predeparture_pack.js";
import read_url from "./read_url.js";
import remember from "./remember.js";
import set_language from "./set_language.js";
import shopping_add from "./shopping_add.js";
import shopping_remove from "./shopping_remove.js";
import strava_routes from "./strava_routes.js";
import sveip from "./sveip.js";
import toggle_kill_switch from "./toggle_kill_switch.js";
import transit_directions from "./transit_directions.js";
import trip_status from "./trip_status.js";
import weather_forecast from "./weather_forecast.js";

export const CATALOGUE: Catalogue = {
  "agent-kit__transit_plan": { capability: "transit", tool: agent_kit_transit_plan },
  calendar_list_events: { capability: "calendar", tool: calendar_list_events },
  currency_convert: { capability: "currency", tool: currency_convert },
  flight_status: { capability: "travel", tool: flight_status },
  info: { capability: "admin", tool: info },
  link_group: { capability: "travel", tool: link_group },
  nearby_places: { capability: "places", tool: nearby_places },
  nytur: { capability: "travel", tool: nytur },
  persona_overlay: { capability: "persona", tool: persona_overlay },
  place_link: { capability: "places", tool: place_link },
  predeparture_pack: { capability: "travel", tool: predeparture_pack },
  read_url: { capability: "read_url", tool: read_url },
  remember: { capability: "vault", tool: remember },
  // Ruling R2: not a capability, has no grant and no capability doc — `capabilityOfTool` returns
  // undefined for it by design. `ALWAYS_PRESENT` short-circuits it before any grant lookup.
  set_language: { capability: ALWAYS_PRESENT_CAPABILITY, tool: set_language },
  shopping_add: { capability: "shopping", tool: shopping_add },
  shopping_remove: { capability: "shopping", tool: shopping_remove },
  strava_routes: { capability: "strava", tool: strava_routes },
  sveip: { capability: "travel", tool: sveip },
  toggle_kill_switch: { capability: "admin", tool: toggle_kill_switch },
  transit_directions: { capability: "places", tool: transit_directions },
  trip_status: { capability: "travel", tool: trip_status },
  weather_forecast: { capability: "places", tool: weather_forecast },
};
