#!/usr/bin/env bash
# LAR-98 local rehearsal of the database half of a keeper-managed switch. MADE-UP DATA ONLY.
#
#   scripts/rehearsal/database-rehearsal.sh build            # old-state databases + made-up data
#   scripts/rehearsal/database-rehearsal.sh apply  <logfile> # box 046..089 + chief-of-staff 004/005, in the deploy order
#   scripts/rehearsal/database-rehearsal.sh eve    <logfile> # the eve upgrade tables, per database
#   scripts/rehearsal/database-rehearsal.sh wayback          # the way-back statements, on a throwaway copy
#
# It talks only to a throwaway Postgres container you started yourself (default name lar98-db, with a
# superuser role named $DB_USER). It never reads a real backup, real data or a real server. The
# "old state" is rebuilt from this repository's own scripts: box 001..045, chief-of-staff 002..003,
# and the eve tables with their OLD primary key (reconstructed by undoing exactly what the
# beta.32-to-beta.42 upgrade script changes; a real server's old tables may differ in other ways).
#
# Run `apply` twice in a row to see that every script is safe to repeat.
set -u
cd "$(dirname "$0")/../.."
C=${DB_CONTAINER:-lar98-db}; U=${DB_USER:-lares}
STATE=${STATE_DB:-lares_state}; TRAVEL=${TRAVEL_DB:-lares_travel}; CREATIVE=${CREATIVE_DB:-lares_creative}; TEMPLATE=${TEMPLATE_DB:-lares_workflow_template}
OWNER=${OWNER_ID:-owner}; OLD_SPELLING=${OLD_SPELLING:-U_OWNER}
Q() { docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -U "$U" "$@"; }
QS() { docker exec -i "$C" psql -X -v ON_ERROR_STOP=1 -U "$U" "$@"; }
box() { printf '%s' "services/box/sql/$1"; }
num() { local n=${1##*/}; echo $((10#${n:0:3})); }

build() {
  for d in $STATE $TRAVEL $CREATIVE $TEMPLATE; do
    docker exec "$C" dropdb -U "$U" --if-exists "$d"; docker exec "$C" createdb -U "$U" "$d"
    f=services/chief-of-staff/sql/001-eve-workflow.sql; [ "$d" = "$CREATIVE" ] && f=services/creative/sql/001-eve-workflow.sql
    Q -d "$d" < "$f"
    # Undo the one thing the beta.32 -> beta.42 upgrade changes, so the upgrade script has something to do.
    Q -d "$d" -c "ALTER TABLE workflow.workflow_events DROP CONSTRAINT workflow_events_run_id_id_pk; ALTER TABLE workflow.workflow_events ADD CONSTRAINT workflow_events_pkey PRIMARY KEY (id); CREATE INDEX workflow_events_run_id_index ON workflow.workflow_events(run_id); DROP TABLE workflow.workflow_event_slots;"
  done
  for f in $(ls services/box/sql | sort); do [ "$(num "$f")" -le 45 ] || continue; Q -d $STATE < "$(box "$f")" || echo "BUILD ERROR in $f"; done
  for f in 002-standing-facts 003-facts-owner; do Q -d $STATE < services/chief-of-staff/sql/$f.sql || echo "BUILD ERROR in $f"; done
  seed
}

seed() {
  # The server's owner columns carry a built-in default naming the owner; the repository's own
  # scripts do not create it, so add it to model the server. Script 088 is what removes it.
  for t in "reminders owner" "email_triage_processed principal" "telegram_daily_log principal" "telegram_session_rotation principal" "outreach_threads principal" "meeting_followup_sent principal" "deadlines owner" "deadline_candidates owner" "standing_facts user_id"; do
    set -- $t; Q -d $STATE -c "ALTER TABLE $1 ALTER COLUMN $2 SET DEFAULT '$OWNER'"
  done
  Q -d $STATE <<SQL
INSERT INTO users(id,display_name,primary_email) VALUES('$OWNER','Made-up Owner','owner@example.test');
INSERT INTO user_aliases(system,alias,user_id) VALUES('google','$OLD_SPELLING','$OWNER'),('slack','$OLD_SPELLING','$OWNER');
INSERT INTO oauth_tokens(principal,provider,org_id,email_address,refresh_token_enc) VALUES
 ('$OLD_SPELLING','google','acme','owner@example.test','ZmFrZS1ibG9i-1'),
 ('$OLD_SPELLING','google','acme','second@example.test','ZmFrZS1ibG9i-2'),
 ('$OLD_SPELLING','google','acme','third@example.test','ZmFrZS1ibG9i-3');
INSERT INTO email_watch_cursors(watcher,principal,email_address,last_polled_at) VALUES
 ('triage','$OLD_SPELLING','owner@example.test',1700000000),('triage','$OLD_SPELLING','second@example.test',1700000001);
INSERT INTO meeting_followup_sent(notion_page_id,principal,outcome) VALUES('page-1','$OWNER','sent'),('page-2','$OWNER','denied');
INSERT INTO standing_facts(fact,category,source_turn,user_id) VALUES('Prefers window seats','travel','t1','$OWNER');
INSERT INTO reminders(agent,owner,due_at,payload,created_by) VALUES('chief-of-staff','$OWNER',now()+interval '1 day','{"text":"call"}','chief-of-staff');
INSERT INTO confirmations(action,args,status) SELECT 'gmail.send','{"to":["a@example.test"]}','pending' FROM generate_series(1,7);
INSERT INTO confirmations(action,args,status,resolved_at) VALUES('gmail.send','{}','approved',now());
INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,org,mailbox,applied_revision,applied_connection)
 VALUES('chief-of-staff','email','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','owner@example.test','$OLD_SPELLING','acme','owner@example.test','22222222-2222-4222-8222-222222222222','{"kind":"email","principal":"$OLD_SPELLING","org":"acme","mailbox":"owner@example.test"}');
INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,state,pending,runtime_control_token) VALUES
 ('chief-of-staff','172.30.0.11','$STATE','owned','11111111-1111-4111-8111-111111111111','ready',false,'11111111-1111-4111-8111-111111111111'),
 ('travel','172.30.0.12','$TRAVEL','owned','33333333-3333-4333-8333-333333333333','ready',false,'33333333-3333-4333-8333-333333333333'),
 ('creative','172.30.0.13','$CREATIVE','owned','44444444-4444-4444-8444-444444444444','ready',false,'44444444-4444-4444-8444-444444444444');
INSERT INTO ratchet(agent,capability,action,level,updated_by) VALUES('chief-of-staff','brain','','gated','owner'),('chief-of-staff','atlas','','gated','owner'),('creative','atlas','','gated','owner');
INSERT INTO approval_events(agent,capability,tool,decision) VALUES('chief-of-staff','brain','note_write','asked'),('creative','atlas','atlas_write','asked');
SQL
  # Three OLD-style stored definitions: the template with its `vault` grant spelled the old way.
  python3 - "$(pwd)" <<'PY' | Q -d $STATE
import json, sys, hashlib
repo = sys.argv[1]
old = {'chief-of-staff': ['brain', 'atlas', 'memory'], 'travel': ['memory'], 'creative': ['atlas']}
for role, caps in old.items():
    d = json.load(open(f'{repo}/packages/agent-kit/templates/{role}/definition.json'))
    d['name'] = role; d['duties'] = 'duties.md'
    d['grants'] = [x for g in d['grants'] for x in ([{'capability': c, 'scope': g['scope'] if c != 'memory' else 'write'} for c in caps] if g['capability'] == 'vault' else [g])]
    d['autonomy'] = dict(i for k, v in d['autonomy'].items() for i in ([(c, v) for c in caps] if k == 'vault' else [(k, v)]))
    body = json.dumps(d).replace("'", "''")
    print(f"INSERT INTO agent_definitions(name,definition,duties,voice,hash,status) VALUES('{role}','{body}'::jsonb,'Made-up duties.','Be concise.','{hashlib.sha256(body.encode()).hexdigest()}','valid');")
PY
  # Unfinished conversations in each agent's own conversation store (the existing server has 216 / 8 / 14).
  for spec in "$STATE:216" "$TRAVEL:8" "$CREATIVE:14"; do
    d=${spec%:*}; n=${spec#*:}
    Q -d "$d" <<SQL
INSERT INTO workflow.workflow_runs(id,deployment_id,status,name) SELECT 'wrun_'||g,'dep1','running','session' FROM generate_series(1,$n) g;
INSERT INTO workflow.workflow_events(id,type,run_id) SELECT 'wevt_'||g||'_'||t,'step_created','wrun_'||g FROM generate_series(1,$n) g, generate_series(1,3) t;
SQL
  done
  echo "built and seeded: $STATE ($TRAVEL, $CREATIVE, $TEMPLATE)"
}

apply() {
  local LOG=$1; : > "$LOG"
  dry() { echo "##### DRY RUN of $1" >> "$LOG"
    awk '/DRY RUN SELECT.*BEGIN/{f=1;next} /DRY RUN SELECT.*END/{f=0} f' "$(box "$1")" | sed 's/^-- \{0,1\}//' | QS -d $STATE >> "$LOG" 2>&1; echo "exit=$?" >> "$LOG"; }
  ap() { echo "##### APPLY $1" >> "$LOG"; QS -d $STATE < "$(box "$1")" >> "$LOG" 2>&1; echo "exit=$? file=$1" >> "$LOG"; echo "$1 -> $(tail -1 "$LOG")"; }
  for f in 037_tyche 046_marcel_schedule_heartbeat 048_meeting_followup_denied 049_backup_status 050_brief_settings; do ap $f.sql; done
  echo "##### BRIEF PIN" >> "$LOG"
  QS -d $STATE >> "$LOG" 2>&1 <<SQL
INSERT INTO brief_settings (owner, language, updated_by) VALUES ('$OWNER', 'nb', 'owner') ON CONFLICT (owner) DO UPDATE SET language = 'nb', updated_by = 'owner', updated_at = now();
SQL
  echo "exit=$? brief pin" >> "$LOG"
  for f in 060_conversation_entries 061_conversation_retention 062_schema_migrations 063_deadline_renewals 065_schedule_settings 070_conversation_prune_heartbeat 071_agent_notes 072_memory_proposals 073_memory_use 074_memory_proposal_add 075_memory_reads 076_forget_ledger 079_repairs 078_telegram_day_handover 081_telegram_handover_written 082_telegram_handover_heartbeat; do ap $f.sql; done
  dry 083_owner_key_is_the_register_id.sql; ap 083_owner_key_is_the_register_id.sql
  ap 084_dream_tables_owner.sql
  dry 085_oauth_principal_is_the_register_id.sql; ap 085_oauth_principal_is_the_register_id.sql
  for f in 086_approval_asks 087_update_history 089_agent_avatars; do ap $f.sql; done
  dry 077_capability_rename.sql; ap 077_capability_rename.sql
  ap 088_explicit_owner_defaults.sql
  for f in 004-standing-facts-origin 005-standing-facts-validity; do echo "##### APPLY chief-of-staff $f" >> "$LOG"; QS -d $STATE < services/chief-of-staff/sql/$f.sql >> "$LOG" 2>&1; echo "exit=$? chief-of-staff $f" >> "$LOG"; echo "chief-of-staff $f -> $(tail -1 "$LOG")"; done
  echo "errors in log: $(grep -ci error "$LOG")"
}

eve() {
  local LOG=$1; : > "$LOG"
  for d in $STATE $TRAVEL $CREATIVE $TEMPLATE; do
    up=services/chief-of-staff/sql/006-eve-workflow-beta32-to-beta42-upgrade.sql; reg=services/chief-of-staff/sql/001-eve-workflow.sql
    [ "$d" = "$CREATIVE" ] && { up=services/creative/sql/002-eve-workflow-beta32-to-beta42-upgrade.sql; reg=services/creative/sql/001-eve-workflow.sql; }
    for f in $up $reg; do echo "##### $d $f" >> "$LOG"; QS -d "$d" < "$f" >> "$LOG" 2>&1; echo "exit=$? $d $(basename "$f")" | tee -a "$LOG"; done
    docker exec "$C" psql -X -U "$U" -d "$d" -Atc "select '$d runs='||(select count(*) from workflow.workflow_runs)||' events='||(select count(*) from workflow.workflow_events)||' new_slots_table='||(to_regclass('workflow.workflow_event_slots') is not null)" | tee -a "$LOG"
  done
  echo "errors in log: $(grep -ci error "$LOG")"
}

wayback() {
  docker exec "$C" dropdb -U "$U" --if-exists lar98_back; docker exec "$C" createdb -U "$U" -T $STATE lar98_back
  B() { docker exec -i "$C" psql -X -v ON_ERROR_STOP=1 -U "$U" -d lar98_back "$@"; }
  echo "--- an old-style meeting follow-up write (no owner named) after 088:"; B -c "INSERT INTO meeting_followup_sent(notion_page_id,outcome) VALUES('page-x','sent')" 2>&1 | head -2
  echo "--- put the default back (the extra step after 088), then the same write:"
  B -c "ALTER TABLE meeting_followup_sent ALTER COLUMN principal SET DEFAULT '$OWNER'" -c "INSERT INTO meeting_followup_sent(notion_page_id,outcome) VALUES('page-x','sent')" 2>&1
  echo "--- 085 rollback block:"
  awk '/ROLLBACK.*BEGIN/{f=1;next} /ROLLBACK.*END/{f=0} f' "$(box 085_oauth_principal_is_the_register_id.sql)" | sed 's/^-- \{0,1\}//' | B 2>&1 | tail -6
  B -Atc "select 'tokens '||principal||' x'||count(*) from oauth_tokens group by principal" -c "select 'door '||principal from agent_door_connections"
  echo "--- 077 rollback block:"
  awk '/ROLLBACK.*BEGIN/{f=1;next} /ROLLBACK.*END/{f=0} f' "$(box 077_capability_rename.sql)" | sed 's/^-- \{0,1\}//;/^-- /d' | B 2>&1 | tail -6
  B -Atc "select 'ratchet '||agent||' '||capability||' action=['||action||']' from ratchet" -c "select 'approval_events '||agent||' '||capability from approval_events"
  docker exec "$C" dropdb -U "$U" lar98_back
}

case "${1:-}" in
  build) build ;; apply) apply "${2:?logfile}" ;; eve) eve "${2:?logfile}" ;; wayback) wayback ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
