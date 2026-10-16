# Local rehearsal of the database half of a switch. MADE-UP DATA ONLY.
#
#   scripts/rehearsal/database-rehearsal.sh build            # databases from the baseline + made-up data
#   scripts/rehearsal/database-rehearsal.sh apply  <logfile> # the standing-facts file again, twice (it must be safe to repeat)
#   scripts/rehearsal/database-rehearsal.sh eve    <logfile> # the eve upgrade tables, per database
#
# It talks only to a throwaway Postgres container with pgvector you started yourself (default name lar98-db, with a
# superuser role named $DB_USER). It never reads a real backup, real data or a real server. The
# state database is built from this repository's own schema file (services/box/sql/001_baseline.sql)
# (which includes the standing-facts table); the eve tables get their OLD primary key
# (reconstructed by undoing exactly what the beta.32-to-beta.42 upgrade script changes; a real
# server's old tables may differ in other ways).
#
# Run `apply` twice in a row to see that every script is safe to repeat.
set -u
cd "$(dirname "$0")/../.."
C=${DB_CONTAINER:-lar98-db}; U=${DB_USER:-lares}
STATE=${STATE_DB:-lares_state}; CREATIVE=${CREATIVE_DB:-lares_creative}; TEMPLATE=${TEMPLATE_DB:-lares_workflow_template}
OWNER=${OWNER_ID:-owner}; OLD_SPELLING=${OLD_SPELLING:-U_OWNER}
Q() { docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -U "$U" "$@"; }
QS() { docker exec -i "$C" psql -X -v ON_ERROR_STOP=1 -U "$U" "$@"; }
box() { printf '%s' "services/box/sql/$1"; }

build() {
  for d in $STATE $CREATIVE $TEMPLATE; do
    docker exec "$C" dropdb -U "$U" --if-exists "$d"; docker exec "$C" createdb -U "$U" "$d"
    f=services/chief-of-staff/sql/001-eve-workflow.sql; [ "$d" = "$CREATIVE" ] && f=services/creative/sql/001-eve-workflow.sql
    Q -d "$d" < "$f"
    # Undo the one thing the beta.32 -> beta.42 upgrade changes, so the upgrade script has something to do.
    Q -d "$d" -c "ALTER TABLE workflow.workflow_events DROP CONSTRAINT workflow_events_run_id_id_pk; ALTER TABLE workflow.workflow_events ADD CONSTRAINT workflow_events_pkey PRIMARY KEY (id); CREATE INDEX workflow_events_run_id_index ON workflow.workflow_events(run_id); DROP TABLE workflow.workflow_event_slots;"
  done
  for f in $(ls services/box/sql | sort); do Q -d $STATE < "$(box "$f")" || echo "BUILD ERROR in $f"; done
  seed
}

seed() {
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
 ('creative','172.30.0.13','$CREATIVE','owned','44444444-4444-4444-8444-444444444444','ready',false,'44444444-4444-4444-8444-444444444444');
INSERT INTO ratchet(agent,capability,action,level,updated_by) VALUES('chief-of-staff','brain','','gated','owner'),('chief-of-staff','atlas','','gated','owner'),('creative','atlas','','gated','owner');
INSERT INTO approval_events(agent,capability,tool,decision) VALUES('chief-of-staff','brain','note_write','asked'),('creative','atlas','atlas_write','asked');
SQL
  # Unfinished conversations in each agent's own conversation store (a long-running server holds a few hundred in one store, a handful in another).
  for spec in "$STATE:200" "$CREATIVE:10"; do
    d=${spec%:*}; n=${spec#*:}
    Q -d "$d" <<SQL
INSERT INTO workflow.workflow_runs(id,deployment_id,status,name) SELECT 'wrun_'||g,'dep1','running','session' FROM generate_series(1,$n) g;
INSERT INTO workflow.workflow_events(id,type,run_id) SELECT 'wevt_'||g||'_'||t,'step_created','wrun_'||g FROM generate_series(1,$n) g, generate_series(1,3) t;
SQL
  done
  echo "built and seeded: $STATE ($CREATIVE, $TEMPLATE)"
}

apply() {
  local LOG=$1; : > "$LOG"
  for round in 1 2; do
    f=002_standing_facts.sql
    echo "##### APPLY box $f (round $round)" >> "$LOG"
    QS -d $STATE < "$(box "$f")" >> "$LOG" 2>&1
    echo "exit=$? box $f round $round" | tee -a "$LOG"
  done
  echo "errors in log: $(grep -ci error "$LOG")"
}

eve() {
  local LOG=$1; : > "$LOG"
  for d in $STATE $CREATIVE $TEMPLATE; do
    up=services/chief-of-staff/sql/006-eve-workflow-beta32-to-beta42-upgrade.sql; reg=services/chief-of-staff/sql/001-eve-workflow.sql
    [ "$d" = "$CREATIVE" ] && { up=services/creative/sql/002-eve-workflow-beta32-to-beta42-upgrade.sql; reg=services/creative/sql/001-eve-workflow.sql; }
    for f in $up $reg; do echo "##### $d $f" >> "$LOG"; QS -d "$d" < "$f" >> "$LOG" 2>&1; echo "exit=$? $d $(basename "$f")" | tee -a "$LOG"; done
    docker exec "$C" psql -X -U "$U" -d "$d" -Atc "select '$d runs='||(select count(*) from workflow.workflow_runs)||' events='||(select count(*) from workflow.workflow_events)||' new_slots_table='||(to_regclass('workflow.workflow_event_slots') is not null)" | tee -a "$LOG"
  done
  echo "errors in log: $(grep -ci error "$LOG")"
}

case "${1:-}" in
  build) build ;; apply) apply "${2:?logfile}" ;; eve) eve "${2:?logfile}" ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
