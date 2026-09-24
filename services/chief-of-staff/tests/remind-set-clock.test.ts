/**
 * remind_set's past-date guard (2026-08-16 live finding): the model has no clock — "in 3
 * minutes" arrived dated June 2025 (right wall-clock time, hallucinated date) and was
 * instantly "due", delivered a second later. A past dueAt is always a model error, and the
 * error message IS the clock: it carries the current time so the model recomputes on retry
 * (the same live session already proved the model reacts correctly to typed tool errors —
 * it fixed its literal "16:XX" after the invalid-format error).
 *
 * Both cases throw BEFORE any DB access, so no Postgres container is needed here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import remindSet from "../catalogue/remind_set.js";

const BENDIK = "U_EXAMPLE_OWNER";

function ctx(auth: unknown) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

const slackAuth = { authenticator: "slack-webhook", attributes: { user_id: BENDIK } };

beforeEach(() => {
  process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK;
});

afterEach(() => {
  delete process.env["SLACK_ALLOWED_USER_IDS"];
});

describe("remind_set clock guard", () => {
  it("rejects a past dueAt with an error that carries the current time (the model's clock)", async () => {
    await expect(
      remindSet.execute(
        { message: "test", dueAt: "2025-06-13T16:55:00+02:00", door: "slack" },
        ctx(slackAuth),
      ),
    ).rejects.toThrow(/is in the past.*It is now .*Europe\/Oslo.*recompute/s);
  });

  it("rejects an unparseable dueAt before the past-check ever runs", async () => {
    await expect(
      remindSet.execute(
        { message: "test", dueAt: "2025-06-13T16:XX:00+02:00", door: "slack" },
        ctx(slackAuth),
      ),
    ).rejects.toThrow(/invalid dueAt/);
  });

  it("allows ~now within the 90s grace (approval-card latency must not bounce an honest reminder)", async () => {
    // 30s in the "past" — inside grace, so validation passes and execution proceeds to the
    // DB layer, which this test intentionally has no Postgres for: reaching a DB error IS
    // the proof the clock guard let it through.
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    let error: unknown;
    try {
      await remindSet.execute(
        { message: "test", dueAt: thirtySecondsAgo, door: "slack" },
        ctx(slackAuth),
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(String(error)).not.toMatch(/is in the past/);
  });
});
