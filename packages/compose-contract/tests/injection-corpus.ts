// Loads the injection corpus (fixtures/injection/*.json). Shared by this package's own corpus
// test and the chief-of-staff builder walk (its test imports this file by relative path).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface InjectionCase {
  id: string;
  family: "tool-invocation" | "gate-bypass" | "exfiltration" | "persona-hijack" | "benign-lookalike";
  lang: "en" | "no";
  /** A string that appears in `text` and must never appear outside a flagged block. */
  marker: string;
  text: string;
}

export function loadInjectionCorpus(): InjectionCase[] {
  const dir = fileURLToPath(new URL("../fixtures/injection/", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(dir + f, "utf8")) as InjectionCase[]);
}
