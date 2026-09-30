# Deploy note — box 085: the Google token rows take the register's id

**What changes.** Two tables name a person with a `principal` — a spelling that predates the
identity register: `oauth_tokens` (the encrypted Google refresh tokens) and
`email_watch_cursors` (the mailbox poll watermarks). Box `085_oauth_principal_is_the_register_id.sql`
renames those values onto the register's id (`users.id`), which is what every other person
column has held since box 083.

On a keeper-managed server a third place holds the same value: the agent's **email** row in
`agent_door_connections`, which is the keeper's own record of which mailbox that agent uses. The
keeper looks the token up by it and refuses to start the agent's email door when it finds none, so
085 moves that row in the same transaction (its `principal`, and the copy inside
`applied_connection`). Slack and Telegram rows in that table hold the door's own user id and are
never touched.

**Why it is safe.** The principal is a lookup key, not key material. `services/box/lib/crypto.ts`
encrypts with AES-256-GCM using `TOKEN_ENC_KEY` directly — no key derivation, no salt, no per-row
key — the nonce is random and stored inside the blob, and `setAAD` is called nowhere in the
repository. `principal` appears only in `WHERE principal=$1` and in the uniqueness key
`(principal, provider, email_address)`. **Nothing is re-encrypted and nobody has to consent
again.** `services/box/tests/oauth-principal-rename.test.ts` proves it on a disposable copy of
the real schema: it stores a real encrypted token under the old spelling, applies 085, asserts
the stored bytes are unchanged, and decrypts it under the new principal with the same key.

**The one real risk.** Three settings — four on a keeper-managed server — still name the principal. If 085 is applied and one of them
still names the old spelling, that reader looks under a name no row has any more, finds nothing,
and reports "no account connected" — it does not crash. That is why they all move in the same
maintenance window. Since this change the engine also says so once in the log when a lookup finds
no token, naming the principal it looked under (`services/box/lib/oauth-tokens.ts`,
`packages/agent-kit/src/google-auth.ts`).

---

## The three settings, and where each one is set

| Setting | Who reads it | Where its value comes from | What the engine defaults to now |
| --- | --- | --- | --- |
| `GOOGLE_PRINCIPAL_ID` | the agents' Gmail, Calendar, Drive, email-triage and voice-learn paths (`services/chief-of-staff/lib/google.ts`, `lib/google-drive.ts`) | the container environment. On a keeper-managed installation the engine writes it itself, from the agent's email claim (`services/keeper/lib/compose-agents.ts:106`, `environment.GOOGLE_PRINCIPAL_ID = e.principal`); `services/keeper/lib/runtime-bindings.ts` lists it among the keys a binding may pass through. Otherwise it is a line in the installation's own compose file, which is not in this repository. | **nothing** — there never was a default here. Unset, the call fails loudly with `GOOGLE_PRINCIPAL_ID is not set and no principal was given`. |
| `CONSOLE_PRINCIPAL_ID` | the console's accounts page, its connect flow and its remove action (`services/console/lib/accounts.ts`) | the console service's environment (documented in `services/console/docs/integrations-and-accounts.md`) | **the owner key** — `ownerId()` (`AGENT_OWNER_USER_ID`), the same rule the console already uses for every other person-keyed row. It used to be a hard-coded legacy literal; that literal is gone. |
| `NOTION_SYNC_PRINCIPAL` | the calendar adapter behind the meeting-attendee job (`services/notion-sync/lib/cli.ts:367`) | the notion-sync container's environment | **nothing, on purpose** — `requireEnv` refuses to start without it, so a wrong value can never be hidden behind a fallback (`services/notion-sync/README.md` states this rule). |

**On a keeper-managed server there is a fourth setting: `runtime.google.principal` in the
keeper's configuration file (`/etc/lares/keeper.json`).** It is the principal the keeper allows a
mailbox to be selected under, and it must equal the email row's `principal` exactly — otherwise
the keeper refuses the agent with "Configure and select a Google mailbox before enabling email"
(`services/keeper/lib/lifecycle.ts`, `connections()`). 085 cannot change a file, so after 085 this
value is the one that is stale until it is edited by hand. The same file's `bindings` may also pass
`GOOGLE_PRINCIPAL_ID` to an agent that has no email door of its own (an agent that only reads the
calendar, for instance); that value is a second copy of the old spelling in the same file.

There is one more reader with no setting of its own: `email_watch_cursors.principal`, written by
the email watcher. It is renamed in the same transaction as the tokens, so the watcher and the
token store cannot disagree about whose mailbox a cursor belongs to. A cursor that did end up
under a stale name would only cost one re-poll from the beginning — it is a watermark, not data.

## The order, on the night

1. **Take the database backup.** Everything below is reversible, but a backup is what makes that
   claim cheap.
2. **Dry run.** Paste the `SELECT` between the `-- DRY RUN SELECT — BEGIN` / `— END` markers in
   `services/box/sql/085_oauth_principal_is_the_register_id.sql` into psql and read the output
   aloud. It writes nothing. Every line says one of four things:
   - `WOULD BECOME <id>` — this value will be renamed;
   - `no change - already the register id` — nothing to do;
   - `LEFT ALONE - the register does not resolve this to exactly one person` — an unknown or
     contested spelling; nothing will happen to it. If it is the owner's, add it as an alias in
     `user_aliases` **before** applying, then dry-run again;
   - `LEFT ALONE - <id> already has a row for this mailbox` — a collision. Both rows stay. Decide
     by hand which one survives, remove the other, and run 085 again afterwards.
3. **Stop the agents** (or accept that a turn mid-window may look unenrolled for a few seconds).
4. **Apply 085** by hand, the way every box migration is applied. It is one transaction and it
   ends by printing the same findings the dry run predicted, `LEFT ALONE` lines first.
5. **Move the settings in the same window** to the register's id — the value the dry run
   printed after `WOULD BECOME`. On a server that is not keeper-managed: `GOOGLE_PRINCIPAL_ID` and
   `NOTION_SYNC_PRINCIPAL` in the installation's compose, and `CONSOLE_PRINCIPAL_ID` on the
   console — or simply remove that one, now that its default is the owner key.

   **On a keeper-managed server, in this order:**
   1. 085 has just moved the token rows, the cursors and the keeper's email row (step 4).
   2. In `/etc/lares/keeper.json`, set `runtime.google.principal` to the register's id.
   3. In the same file, change every `GOOGLE_PRINCIPAL_ID` under `bindings` / `defaultBindings`
      to the register's id.
   4. Restart the keeper so it reads the file, then reconcile each agent from the console
      ("Apply connection changes"). That rewrites the agents' compose from the email row, which is
      how an agent with an email door gets its new `GOOGLE_PRINCIPAL_ID` — nobody edits it by hand.
   5. `CONSOLE_PRINCIPAL_ID` on the console: set it to the register's id, or remove it.
   6. `NOTION_SYNC_PRINCIPAL` in the notion-sync container's environment.

   Doing 2 before 1, or 1 without 2, gives the same refusal from the keeper: the file and the row
   have to name the same id.
6. **Restart** the agents (done by the reconcile above on a keeper-managed server), the sync jobs
   and the console.
7. **Verify** (below).

## Verify

```sql
-- 1. Nothing is left under a spelling the register resolves to somebody else.
--    Re-run the dry-run SELECT from the migration header: no line may say WOULD BECOME.

-- 2. The rows are where the readers will look.
SELECT principal, provider, email_address FROM oauth_tokens ORDER BY principal, email_address;
SELECT watcher, principal, email_address FROM email_watch_cursors ORDER BY 1, 2;

-- 3. Keeper-managed server: the keeper's email row names the same id as keeper.json.
SELECT agent, principal, applied_connection->>'principal' AS applied, org, mailbox
  FROM agent_door_connections WHERE kind = 'email';
```

Then, in the running system:

- the console's Integrations page lists the Google accounts (it reads by provider, so it lists
  them either way — check that the principal column matches the new id);
- on a keeper-managed server, the reconcile in step 5 finished without "Configure and select a
  Google mailbox before enabling email" or "Selected Google mailbox is no longer connected";
- one calendar read and one Gmail read succeed from the agent;
- the logs carry no `no google token is stored under the principal "…"` line. If they do, that
  line names the principal a reader is still looking under: that setting was missed.

**If a mailbox is missing after all this, the remedy is to connect that Google account again.**
That is the outcome the owner accepted when reversing the freeze — it is the fallback for a row
that was missed, not a step in this procedure.

## Rollback

The old spellings are not guessed back; they are read back out of `user_aliases`, which this
migration deliberately does not touch. The exact statements are in the migration's header between
the `-- ROLLBACK — BEGIN` / `— END` markers, and a test runs forward → back → forward against
them. Two things to check before pasting:

- they restore the ONE alias registered under the system named in the `system = 'google'`
  lines. If the spelling a reader used lives under a different alias system (a case-divergent
  watcher spelling is usually registered under `'legacy'`), change those lines, or run the
  block once per system;
- a person with several aliases in the named system is skipped rather than given an arbitrary
  one — for those, name the alias literally:
  `UPDATE oauth_tokens SET principal = '<the old spelling>' WHERE principal = '<the register id>';`

Put the settings back at the same time — including `runtime.google.principal` and any binding in
`keeper.json` —, or the rollback has the same failure mode as the
migration it undoes.
