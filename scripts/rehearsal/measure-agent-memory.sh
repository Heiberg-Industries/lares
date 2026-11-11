#!/bin/sh
# Records how much memory each agent container uses on an install. It only reads: nothing on the
# machine is changed, apart from the one text file you ask for with --out.
#
#   scripts/rehearsal/measure-agent-memory.sh [--label <text>] [--out <dir>] [--compare <older-file>] [container ...]
#
#   --label <text>          a word for this moment, written into the output (after-start, after-chat, after-a-day)
#   --out <dir>             also save the output in <dir> as a text file named after the time and the label
#   --compare <older-file>  also print, per container, the change in total and per-process memory since that file
#   container ...           measure only these containers; without names, every running container whose
#                           name starts with "lares-" (that can be more than the agents: give names to narrow it)
#
# For each container it prints: the total memory in use and the limit; each process inside it with
# its own memory (so a launcher and a server show separately); what the memory is made of; how full
# /tmp is; and the Node heap limit when that can be read without starting anything. Then one summary
# line per container and a total.
#
# Of a process's command line only the program and its first argument are printed, and a value
# after "=" or anything that looks like an address is replaced by [hidden]. Environment variables are
# never printed. Run it as a user who may use Docker (often: with sudo).
#
# Measuring memory
# ----------------
# Measure the same install at three moments, with the same command and a different label:
#
#   1. just after start          ... --label after-start --out ./memory
#   2. after a few chat turns    ... --label after-chat  --out ./memory
#   3. after a day of running    ... --label after-a-day --out ./memory
#
# To see what changed, add --compare with an earlier file to a later run:
#
#   ... --label after-a-day --out ./memory --compare ./memory/agent-memory-<time>-after-start.txt
#
# What to look at: the total per container against its limit; whether the server process keeps
# growing between the three moments; "shmem" together with /tmp (files in /tmp are held in memory and
# are not given back); and memory.peak, the highest the container has been.
#
# Tests: scripts/rehearsal/measure-agent-memory.test.sh (needs no Docker). LARES_MEASURE_DOCKER=<path>
# makes the script call that command instead of docker; the test uses it with a stand-in.
set -u

DOCKER=${LARES_MEASURE_DOCKER:-docker}
PREFIX=lares-
LABEL=''; OUT=''; COMPARE=''; NAMES=''

stop() { printf '%s\n' "$1" >&2; exit 1; }
misuse() { printf '%s\nRun it with --help to see how it is used.\n' "$1" >&2; exit 2; }
show_help() { sed -n '2,/^set -u$/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case $1 in
    --label|--out|--compare)
      [ $# -ge 2 ] || misuse "$1 needs a value after it."
      case $1 in --label) LABEL=$2 ;; --out) OUT=$2 ;; --compare) COMPARE=$2 ;; esac
      shift 2 ;;
    --label=*) LABEL=${1#*=}; shift ;;
    --out=*) OUT=${1#*=}; shift ;;
    --compare=*) COMPARE=${1#*=}; shift ;;
    -h|--help) show_help; exit 0 ;;
    -*) misuse "Unknown option: $1" ;;
    *)
      # Docker's own rule for container names; it also keeps anything odd away from the docker command line.
      case $1 in *[!A-Za-z0-9_.-]*) misuse "Not a container name: $1" ;; esac
      NAMES="$NAMES $1"; shift ;;
  esac
done

# The label goes into the output and into a file name: keep it to one short line.
LABEL=$(printf '%s' "$LABEL" | tr -d '\n\r' | cut -c1-60)
[ -n "$LABEL" ] || LABEL='(none)'
FILE_LABEL=$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '-' | sed -e 's/--*/-/g' -e 's/^-//' -e 's/-$//')
[ -n "$FILE_LABEL" ] || FILE_LABEL=no-label

if [ -n "$COMPARE" ]; then
  [ -r "$COMPARE" ] || stop "The file to compare with cannot be read: $COMPARE. Nothing was measured."
  grep -q '^@total ' "$COMPARE" || stop "The file to compare with is not a measurement saved by this script: $COMPARE. Nothing was measured."
fi
if [ -n "$OUT" ] && [ -e "$OUT" ] && [ ! -d "$OUT" ]; then
  stop "--out needs a folder, and $OUT is a file. Nothing was measured."
fi

command -v "$DOCKER" >/dev/null 2>&1 ||
  stop "Docker is not available here: the command \"$DOCKER\" was not found. Nothing was measured."
RUNNING=$("$DOCKER" ps --format '{{.Names}}' 2>/dev/null) ||
  stop "Docker is installed but did not answer. Is it running, and may this user use it (try with sudo)? Nothing was measured."

TARGETS=''; MISSING=''
if [ -n "$NAMES" ]; then
  for n in $NAMES; do
    if printf '%s\n' "$RUNNING" | grep -qxF -e "$n"; then TARGETS="$TARGETS $n"; else MISSING="$MISSING $n"; fi
  done
  [ -n "$TARGETS" ] || stop "None of the containers you named is running:$MISSING. Nothing was measured."
else
  TARGETS=$(printf '%s\n' "$RUNNING" | grep "^$PREFIX" | sort | tr '\n' ' ')
  [ -n "$TARGETS" ] || stop "No running container has a name that starts with \"$PREFIX\". Nothing was measured."
fi
# shellcheck disable=SC2086  # a list of checked container names, split on purpose
set -- $TARGETS
COUNT=$#

# "412.3MiB" (the way docker stats writes a size) -> whole KiB. Prints nothing when it is not a size.
to_kib() {
  printf '%s\n' "$1" | awk '{
    s = $0; gsub(/[ \t]/, "", s); n = s; sub(/[A-Za-z]+$/, "", n); u = substr(s, length(n) + 1)
    if (n !~ /^[0-9]+(\.[0-9]+)?$/) exit
    if (u == "B") m = 1 / 1024; else if (u == "KiB") m = 1; else if (u == "MiB") m = 1024
    else if (u == "GiB") m = 1048576; else if (u == "TiB") m = 1073741824
    else if (u == "kB" || u == "KB") m = 1000 / 1024; else if (u == "MB") m = 1000000 / 1024
    else if (u == "GB") m = 1000000000 / 1024; else exit
    printf "%.0f\n", n * m }'
}
kib_mib() { awk -v k="$1" 'BEGIN { printf "%.1f", k / 1024 }'; }
bytes_mib() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1048576 }'; }
is_number() { case $1 in ''|*[!0-9]*) return 1 ;; esac; return 0; }

# `docker top` rows -> "pid|resident KiB|program and first argument". This is the only place a command
# line is turned into text that gets printed: a value after "=" and anything that looks like an
# address (it could carry a password) are replaced, long words are cut, the rest is dropped.
# shellcheck disable=SC2016  # an awk program, not shell
PROCESS_ROWS='
function safe(w,   i) {
  if (w ~ /:\/\// || w ~ /@/) return "[hidden]"
  i = index(w, "="); if (i > 0) return substr(w, 1, i) "[hidden]"
  if (length(w) > 60) return substr(w, 1, 57) "..."
  return w
}
NR > 1 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && NF >= 3 {
  text = safe($3); if (NF >= 4) text = text " " safe($4)
  gsub(/\|/, "/", text)
  print $1 "|" $2 "|" text
}'

DATA=''; SUMMARY=''; TOTAL_KIB=0; COUNTED=0
add_data() { DATA="$DATA
$1"; }

block() {
  c=$1
  printf '\n== %s ==\n' "$c"

  # 1. the container's total and its limit
  printf '\n1. Memory in use, and the limit\n'
  row=$(printf '%s\n' "$STATS" | awk -F'|' -v n="$c" '$1 == n { print; exit }')
  usage=$(printf '%s\n' "$row" | awk -F'|' '{ print $2 }')
  percent=$(printf '%s\n' "$row" | awk -F'|' '{ gsub(/ /, "", $3); print $3 }')
  used_kib=$(to_kib "${usage%%/*}"); limit_kib=$(to_kib "${usage##*/}")
  if [ -n "$used_kib" ] && [ -n "$limit_kib" ]; then
    used_text="$(kib_mib "$used_kib") MiB"; limit_text="$(kib_mib "$limit_kib") MiB"
    printf '     %s of a %s limit (%s)     as Docker writes it: %s\n' "$used_text" "$limit_text" "${percent:-?}" "$usage"
    printf '     (when a container has no limit of its own, Docker shows the whole server'\''s memory as the limit)\n'
    TOTAL_KIB=$((TOTAL_KIB + used_kib)); COUNTED=$((COUNTED + 1))
    add_data "@total $used_kib $limit_kib $c"
  else
    used_text='not available'; limit_text='-'; percent='-'
    printf '     not available (docker stats gave no figures for this container)\n'
  fi

  # 2. each process inside it
  printf '\n2. Processes inside it, with the memory each one holds\n'
  top=$("$DOCKER" top "$c" -o pid,rss,args 2>/dev/null) || top=''
  rows=$(printf '%s\n' "$top" | awk "$PROCESS_ROWS")
  if [ -n "$rows" ]; then
    printf '         PID       MEMORY  PROGRAM AND FIRST ARGUMENT\n'
    printf '%s\n' "$rows" | awk -F'|' '{ t = $0; sub(/^[^|]*\|[^|]*\|/, "", t); printf "     %7s  %7.1f MiB  %s\n", $1, $2 / 1024, t }'
    printf '     (processes share some memory, so these need not add up to the total above)\n'
    proc_count=$(printf '%s\n' "$rows" | awk 'END { print NR }')
    largest="$(printf '%s\n' "$rows" | awk -F'|' '$2 + 0 > m { m = $2 + 0 } END { printf "%.1f", m / 1024 }') MiB"
    # For --compare: one line per distinct command, because process numbers change when a container restarts.
    procs=$(printf '%s\n' "$rows" | awk -F'|' -v c="$c" '
      { t = $0; sub(/^[^|]*\|[^|]*\|/, "", t); if (!(t in kib)) order[++n] = t; kib[t] += $2; count[t]++ }
      END { for (i = 1; i <= n; i++) print "@proc", kib[order[i]], count[order[i]], c, order[i] }')
    add_data "$procs"
  else
    proc_count='-'; largest='-'
    printf '     not available (docker top gave no process list for this container)\n'
  fi

  # 3. what the memory is made of, from the container's own cgroup files
  printf '\n3. What the memory is made of (the container'\''s own accounting)\n'
  stat=$("$DOCKER" exec "$c" cat /sys/fs/cgroup/memory.stat 2>/dev/null) || stat=''
  shmem_text='-'
  if [ -n "$stat" ]; then
    for key in anon file shmem kernel sock; do
      case $key in
        anon) meaning='memory the programs themselves hold' ;;
        file) meaning='files kept in memory for speed; given back when memory runs short' ;;
        shmem) meaning='files in memory-backed folders such as /tmp; not given back' ;;
        kernel) meaning='the operating system'\''s bookkeeping for this container' ;;
        *) meaning='network buffers' ;;
      esac
      value=$(printf '%s\n' "$stat" | awk -v k="$key" '$1 == k && $2 ~ /^[0-9]+$/ { print $2; exit }')
      if [ -n "$value" ]; then
        printf '     %-15s %8s MiB   %s\n' "$key" "$(bytes_mib "$value")" "$meaning"
        [ "$key" = shmem ] && shmem_text="$(bytes_mib "$value") MiB"
      else
        printf '     %-15s not available (this line is not in memory.stat here)\n' "$key"
      fi
    done
  else
    printf '     anon, file, shmem, kernel, sock: not available (memory.stat could not be read in this container)\n'
  fi
  for name in memory.current memory.peak; do
    case $name in
      memory.current) meaning='in use right now, counting the files kept in memory' ;;
      *) meaning='the highest it has been since the container started' ;;
    esac
    value=$("$DOCKER" exec "$c" cat "/sys/fs/cgroup/$name" 2>/dev/null) || value=''
    if is_number "$value"; then
      printf '     %-15s %8s MiB   %s\n' "$name" "$(bytes_mib "$value")" "$meaning"
    else
      printf '     %-15s not available (the file is missing or could not be read)\n' "$name"
    fi
  done

  # 4. how full /tmp is
  printf '\n4. How full /tmp is inside it\n'
  tmp_text='-'
  disk=$("$DOCKER" exec "$c" df -h /tmp 2>/dev/null) || disk=''
  if [ -n "$disk" ]; then
    printf '%s\n' "$disk" | sed 's/^/     /'
    tmp_text=$(printf '%s\n' "$disk" | awk 'END { if (NF >= 5 && $(NF - 1) ~ /%$/) print $(NF - 3) " used (" $(NF - 1) ")"; else print "-" }')
  else
    printf '     not available (df could not be run in this container)\n'
  fi

  # 5. the Node heap limit. Only read from what is already visible: the server process's command line
  # (never printed) and the NODE_OPTIONS setting. Asking Node itself would mean starting a second Node
  # process inside the container, which uses memory there and could raise memory.peak, so it is not done.
  printf '\n5. Node heap limit of the main process\n'
  node=$(printf '%s\n' "$top" | awk '
    NR > 1 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {
      p = $3; sub(/.*\//, "", p)
      if ((p == "node" || p == "nodejs") && (!found || $2 + 0 > best)) { found = 1; best = $2 + 0; pid = $1; line = $0 }
    }
    END {
      if (!found) exit
      v = "-"
      if (match(line, /--max[-_]old[-_]space[-_]size=[0-9]+/)) { v = substr(line, RSTART, RLENGTH); sub(/.*=/, "", v) }
      print pid, v
    }')
  if [ -z "$node" ]; then
    printf '     not available (no Node process was found in this container)\n'
  elif [ "${node#* }" != - ]; then
    printf '     %s MiB (set with --max-old-space-size on the command line of the largest Node process, PID %s)\n' "${node#* }" "${node%% *}"
  else
    setting=$("$DOCKER" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null |
      sed -n 's/^NODE_OPTIONS=.*--max[-_]old[-_]space[-_]size=\([0-9][0-9]*\).*/\1/p' | sed -n '1p')
    if [ -n "$setting" ]; then
      printf '     %s MiB (set with --max-old-space-size in the container'\''s NODE_OPTIONS setting)\n' "$setting"
    else
      printf '     not available (no --max-old-space-size is set, so Node chose its own default; reading that\n'
      printf '     would mean starting a second Node process inside the container, which this script does not do)\n'
    fi
  fi

  SUMMARY="$SUMMARY
$(printf '  %-34s %12s %12s %10s %10s %16s %12s  %s' "$c" "$used_text" "$limit_text" "$percent" "$proc_count" "$largest" "$shmem_text" "$tmp_text")"
}

# Per container: total and per-process change between the older file and this run.
# shellcheck disable=SC2016  # an awk program, not shell
COMPARE_LINES='
function mib(k) { return sprintf("%.1f MiB", k / 1024) }
function change(a, b) { return sprintf("%10s -> %10s   %+.1f MiB", mib(a), mib(b), (b - a) / 1024) }
function times(n) { return n > 1 ? " (x" n ")" : "" }
$1 == "@taken" { t = $0; sub(/^@taken /, "", t); taken[src] = t; next }
$1 == "@label" { t = $0; sub(/^@label /, "", t); label[src] = t; next }
$1 == "@total" { total[src, $4] = $2; if (!($4 in known)) { known[$4] = 1; names[++nn] = $4 } next }
$1 == "@proc" {
  t = $0; sub(/^@proc [^ ]+ [^ ]+ [^ ]+ /, "", t)
  kib[src, $4, t] = $2; count[src, $4, t] = $3
  if (!(($4, t) in seen)) { seen[$4, t] = 1; np[$4]++; proc[$4, np[$4]] = t }
  next
}
END {
  printf "\nChange since the older measurement\n"
  printf "  older: taken %s, label %s (%s)\n", taken["old"], label["old"], file
  printf "  now:   taken %s, label %s\n", taken["new"], label["new"]
  for (i = 1; i <= nn; i++) {
    c = names[i]
    if (!(("new", c) in total)) { gone = gone " " c; continue }
    printf "\n  %s\n", c
    if (!(("old", c) in total)) { printf "    not in the older file, so there is nothing to compare with\n"; continue }
    printf "    %-44s %s\n", "total", change(total["old", c], total["new", c])
    both++; sum_old += total["old", c]; sum_new += total["new", c]
    for (j = 1; j <= np[c]; j++) {
      t = proc[c, j]; was = (("old", c, t) in kib); is = (("new", c, t) in kib)
      name = substr(t, 1, 44)
      if (was && is) printf "    %-44s %s%s\n", name, change(kib["old", c, t], kib["new", c, t]), times(count["new", c, t])
      else if (is) printf "    %-44s %10s -> %10s   new since then%s\n", name, "-", mib(kib["new", c, t]), times(count["new", c, t])
      else printf "    %-44s %10s -> %10s   no longer there\n", name, mib(kib["old", c, t]), "-"
    }
  }
  if (both > 0) printf "\n  %-46s %s\n", "All " both " container(s) in both measurements", change(sum_old, sum_new)
  if (gone != "") printf "\n  In the older file but not measured now:%s\n", gone
}'

report() {
  printf 'Lares agent memory measurement\n'
  printf 'Taken:  %s\n' "$TAKEN"
  printf 'Label:  %s\n' "$LABEL"
  printf 'Containers measured (%s): %s\n' "$COUNT" "$*"
  if [ -n "$NAMES" ]; then
    [ -z "$MISSING" ] || printf 'Named but not running, so not measured:%s\n' "$MISSING"
  else
    printf 'Every running container whose name starts with "%s" is included, which can be more than the\n' "$PREFIX"
    printf 'agents. To measure only some of them, give their names after the command.\n'
  fi
  printf 'Nothing on this machine was changed. Memory is shown in MiB (1024 MiB = 1 GiB).\n'
  add_data "@taken $TAKEN"; add_data "@label $LABEL"

  for c in "$@"; do block "$c"; done

  printf '\n== Summary ==\n\n'
  printf '  %-34s %12s %12s %10s %10s %16s %12s  %s\n' CONTAINER 'IN USE' LIMIT 'OF LIMIT' PROCESSES 'LARGEST PROCESS' SHMEM /tmp
  printf '%s\n' "${SUMMARY#?}"
  printf '\n  Total in use, %s of %s container(s): %s MiB\n' "$COUNTED" "$COUNT" "$(kib_mib "$TOTAL_KIB")"
  [ "$COUNTED" -eq "$COUNT" ] || printf '  (the total leaves out the containers Docker gave no figures for)\n'

  if [ -n "$COMPARE" ]; then
    printf '%s\n' "$DATA" | awk -v file="$COMPARE" "$COMPARE_LINES" src=old "$COMPARE" src=new -
  fi

  printf '\n----- The same numbers once more, in KiB, for --compare. You can ignore these lines. -----\n'
  printf '%s\n' "${DATA#?}"
}

printf 'Measuring %s container(s); this takes a few seconds.\n' "$COUNT" >&2
TAKEN=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
# One call for all of them, so the totals are from the same moment.
STATS=$("$DOCKER" stats --no-stream --format '{{.Name}}|{{.MemUsage}}|{{.MemPerc}}' "$@" 2>/dev/null) || STATS=''
RESULT=$(report "$@")
printf '%s\n' "$RESULT"

if [ -n "$OUT" ]; then
  saved="$OUT/agent-memory-$(date -u '+%Y%m%dT%H%M%SZ')-$FILE_LABEL.txt"
  mkdir -p "$OUT" 2>/dev/null || stop "The measurement above could not be saved: the folder $OUT could not be made."
  printf '%s\n' "$RESULT" > "$saved" || stop "The measurement above could not be saved in $OUT."
  printf '\nSaved as %s\n' "$saved"
fi
