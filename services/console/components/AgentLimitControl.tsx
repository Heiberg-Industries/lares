"use client";
import { useState, useTransition } from "react";
import { setAgentLimit } from "../app/actions/definition";
import type { Capacity } from "../lib/builder";

const GIB = 1024 ** 3;
const gib = (bytes: number) => `${(Math.round((bytes / GIB) * 10) / 10).toString()} GiB`;
const noun = (n: number) => (n === 1 ? "agent" : "agents");

/** The agent limit. Only the administrator gets the field; everyone else sees the number. The
 * memory figures come from the keeper and are estimates; an older keeper sends none, and then
 * only the number is shown. */
export function AgentLimitControl({ capacity }: { capacity: Capacity }) {
  const [current, setCurrent] = useState(capacity.ceiling);
  const [suggestedMax, setSuggestedMax] = useState(capacity.suggestedMax ?? null);
  const [value, setValue] = useState(String(capacity.ceiling ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const memory = capacity.serverMemoryBytes ?? null;
  const editable = capacity.canChange === true;
  const number = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(number) && number >= 0 && number <= 50;
  const tooHigh = valid && suggestedMax !== null && number > suggestedMax;
  const save = () => {
    setError(null); setSaved(false);
    start(async () => {
      const r = await setAgentLimit({ ceiling: number });
      if (!r.ok) { setError(r.error.message); return; }
      setCurrent(r.result.ceiling);
      setSuggestedMax(r.result.suggestedMax ?? null);
      setValue(String(r.result.ceiling ?? number));
      setSaved(true);
    });
  };
  return (
    <>
      <div className="lares-setting-row">
        <div>
          Agent limit
          <p>
            {current === null ? "Not set yet." : `This server may run up to ${current} ${noun(current)}. You have ${capacity.activeCount}.`}
            {" "}It protects the server from running out of memory.
          </p>
        </div>
        {!editable && <span className="mono" data-testid="agent-limit">{current ?? "Not set"}</span>}
      </div>
      {memory !== null && (
        <p className="lares-muted">
          This server has about {gib(memory)} of memory. As a rough estimate, each agent needs about 1.5 GiB, the rest of Lares about 2.5 GiB, and 2 GiB should stay free.
          {suggestedMax !== null && ` On that basis, about ${suggestedMax} ${noun(suggestedMax)} fit.`} These are estimates, not measurements.
        </p>
      )}
      {editable && (
        <form onSubmit={e => { e.preventDefault(); if (valid && !pending) save(); }}>
          <label>
            New limit (0 to 50)
            <input type="number" min={0} max={50} step={1} inputMode="numeric" value={value} onChange={e => { setValue(e.target.value); setSaved(false); }} />
          </label>{" "}
          <button type="submit" disabled={!valid || pending}>{pending ? "Saving…" : "Save"}</button>
          {tooHigh && <p role="alert">This is more than the estimate of about {suggestedMax} {noun(suggestedMax!)} this server can hold. You can still save it, but the server may run out of memory.</p>}
          {error && <p role="alert">{error}</p>}
          {saved && <p role="status">Saved. The limit is now {current}.</p>}
        </form>
      )}
    </>
  );
}
