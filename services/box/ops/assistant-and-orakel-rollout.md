# Rollout: Slack Assistant UX + Orakel for Saga (2026-06-26)

Two changes landed in `services/agent-runtime`. Both are **safe no-ops until you flip the
switches below** — the code is merged but dormant.

## 1. Orakel for Saga (company intelligence)

Saga now has a read-only `orakel` hand — the same Orakel API Nora uses — with three actions:
`searchByName` (name → candidates), `enrichByOrgNumber`, `enrichByDomain`. The lookups now
return briefing-grade fields: latest revenue / operating & net result + fiscal year,
financial-health score, revenue CAGR, ownership concentration / foreign-owned, bankruptcy &
debt-negotiation status, size class, municipality. (Nora's lookups got the richer fields too.)

**To activate on the box:** set these in Saga's environment (same values Nora uses):
- `ORAKEL_URL` — Orakel API base URL
- `orakel-key` secret file at `/run/secrets/orakel-key` (or `ORAKEL_KEY_FILE` pointing to it)

Without them Saga's Orakel tools degrade gracefully to "company not found" — no crash. After
setting them, rebuild the agent-runtime image and redeploy Saga (Coolify/compose, manual).

## 2. Slack "Agent or Assistant" UX (Saga + Calliope)

When enabled: a greeting + suggested prompts when you open the agent's assistant pane, a native
"thinking…" status during a turn (replaces the "👀 on it…" text line), and an auto thread title
from the first message. The 👍/❌ confirm flow is unchanged. Tyche is Telegram-only → N/A.

Gated by an env flag so the code change is dormant until BOTH the Slack app and the flag are on:

**Per app (do this on Saga's app, then Calliope's app) at api.slack.com → Your Apps:**
1. Features → **Agents & AI Apps** → toggle **Agent or Assistant** ON.
2. OAuth & Permissions → add bot scope **`assistant:write`**.
3. Event Subscriptions → subscribe to bot event **`assistant_thread_started`**
   (optional: `assistant_thread_context_changed`).
4. **Reinstall** the app (mints a new bot token carrying the scope).

**Then on the box:** set `SAGA_ASSISTANT=1` (and `CALLIOPE_ASSISTANT=1`), rebuild + redeploy.

If you flip the env flag WITHOUT enabling the Slack feature first, the text ack disappears but
the native status can't show → the agent feels silent. Order: Slack app first, then the flag.

## Verify

- Orakel: DM Saga "Search Orakel for <a Norwegian company name>" → she returns candidates;
  then "tell me about org number <n>" → revenue/health/ownership in the answer.
- Assistant: open Saga's assistant pane → greeting + suggested prompts appear; send a message →
  "thinking…" status shows while she works, clears when she replies; the thread gets a title.
