#!/bin/sh
# Records how much memory each agent container uses on an install. It only reads: nothing on the
# machine is changed, apart from the one text file you ask for with --out, and by default nothing is
# started inside the containers.
#
#   scripts/rehearsal/measure-agent-memory.sh [--label <text>] [--out <dir>] [--compare <older-file>]
#                                             [--public] [--inside] [container ...]
#
#   --label <text>          a word for this moment, written into the output (after-start, after-chat, after-a-day)
#   --out <dir>             also save the output in <dir> as a text file named after the time and the label
#   --compare <older-file>  also print, per container, the change in total and per-process memory since that file
#   --public                output that can be pasted somewhere public as it is: containers are shown as
#                           agent-1, agent-2, ... (numbered in the alphabetical order of their names), and
#                           no program name, path or folder is printed
#   --inside                allow short read-only commands (cat, df) to be started inside the containers.
#                           Without it nothing is started there, because that changes the number measured
#   container ...           measure only these containers; without names, every running container whose
#                           name starts with "lares-" (that can be more than the agents: give names to narrow it)
#
# The headline figure per container, "in use", is memory.current less inactive_file (what docker
# stats shows), taken as the highest of 4 looks 2 seconds apart. The run therefore takes a little
# over 6 seconds. All four looks are printed.
#
# Where the numbers come from, in this order of preference:
#   1. the host's own cgroup files for the container (found through the container's first process).
#      This needs a server where those files can be read; running the script as root is the sure way.
#   2. with --inside only: the same files read by a short command started inside the container.
#   3. otherwise docker stats alone; the breakdown of the memory is then "not available".
# The output says for every figure which of these it came from.
#
# For each container it prints: the memory in use and the limit; each process inside it with its own
# memory (so a launcher and a server show separately); what the memory is made of; how much is held
# by memory-backed folders such as /tmp; and the Node heap limit when that is visible without
# starting anything. Then one summary line per container and a total.
#
# Of a process only the program's name is printed, never an argument, and with --public not even
# that. Environment variables are never printed. Run it as a user who may use Docker.
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
# Compare like with like: a --public file with a --public run, and the same containers running.
#
# What to look at: "in use" per container against its limit; whether the server process keeps
# growing between the three moments; "shmem" (files in /tmp and other memory-backed folders are held
# in memory and are not given back); and memory.peak, the highest the container has been.
#
# Tests: scripts/rehearsal/measure-agent-memory.test.sh (needs no Docker). It uses four stand-ins:
# LARES_MEASURE_DOCKER and LARES_MEASURE_SLEEP are commands called instead of docker and sleep;
# LARES_MEASURE_PROC and LARES_MEASURE_CGROUP are folders read instead of /proc and /sys/fs/cgroup.
set -u

DOCKER=${LARES_MEASURE_DOCKER:-docker}
SLEEP=${LARES_MEASURE_SLEEP:-sleep}
PROC=${LARES_MEASURE_PROC:-/proc}
CGROUP=${LARES_MEASURE_CGROUP:-/sys/fs/cgroup}
PREFIX=lares-
LOOKS=4; GAP=2
LABEL=''; OUT=''; COMPARE=''; NAMES=''; MODE=normal; INSIDE=''

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
    --public) MODE=public; shift ;;
    --inside) INSIDE=yes; shift ;;
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
  [ -r "$COMPARE" ] || stop "The file to compare with cannot be read. Nothing was measured."
  grep -q '^@total ' "$COMPARE" || stop "The file to compare with is not a measurement saved by this script. Nothing was measured."
  older_mode=$(sed -n 's/^@mode //p' "$COMPARE" | sed -n '1p')
  [ "${older_mode:-normal}" = "$MODE" ] ||
    stop "The file to compare with was made in ${older_mode:-normal} mode and this run is in $MODE mode, so the names would not match. Use the same mode for both. Nothing was measured."
fi
if [ -n "$OUT" ] && [ -e "$OUT" ] && [ ! -d "$OUT" ]; then
  stop "--out needs a folder, and what was given is a file. Nothing was measured."
fi

command -v "$DOCKER" >/dev/null 2>&1 ||
  stop "Docker is not available here: the docker command was not found. Nothing was measured."
RUNNING=$("$DOCKER" ps --format '{{.Names}}' 2>/dev/null) ||
  stop "Docker is installed but did not answer. Is it running, and may this user use it (try with sudo)? Nothing was measured."

TARGETS=''; MISSING=''; MISSING_COUNT=0
if [ -n "$NAMES" ]; then
  for n in $NAMES; do
    if printf '%s\n' "$RUNNING" | grep -qxF -e "$n"; then TARGETS="$TARGETS $n"; else MISSING="$MISSING $n"; MISSING_COUNT=$((MISSING_COUNT + 1)); fi
  done
  if [ -z "$TARGETS" ]; then
    [ "$MODE" = public ] && stop "None of the containers you named is running. Nothing was measured."
    stop "None of the containers you named is running:$MISSING. Nothing was measured."
  fi
  # shellcheck disable=SC2086  # a list of checked container names, split on purpose
  TARGETS=$(printf '%s\n' $TARGETS | sort -u | tr '\n' ' ')
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
# One value out of a memory.stat text: stat_value <key> <text>
stat_value() { printf '%s\n' "$2" | awk -v k="$1" '$1 == k && $2 ~ /^[0-9]+$/ { print $2; exit }'; }
# Numbered variables, one set per container (this is plain sh: no arrays). The names are built here
# from a fixed word and a count, never from anything read on the machine.
setv() { eval "$1=\$2"; }
getv() { eval "printf '%s' \"\${$1-}\""; }

# Why a figure is missing, as one fixed sentence. Docker's own error text is never printed: it can
# carry names.
why() {
  state=$("$DOCKER" inspect --format '{{.State.Running}}' "$1" 2>/dev/null) || state=''
  if [ "$state" = true ]; then printf 'the container is still running, but %s gave nothing' "$2"
  else printf 'the container stopped or was removed while it was being measured'; fi
}
stats_row() { "$DOCKER" stats --no-stream --format '{{.MemUsage}}|{{.MemPerc}}' "$1" 2>/dev/null; }
source_text() {
  case $1 in
    host) printf 'the host'\''s cgroup files (nothing was started in the container)' ;;
    inside) printf 'a short command started inside the container (--inside)' ;;
    *) printf 'docker stats' ;;
  esac
}

# Where each container's numbers will come from. The host's cgroup directory is found the way the
# kernel names it: the "0::" line of /proc/<first process>/cgroup, under /sys/fs/cgroup.
i=0
for c in "$@"; do
  i=$((i + 1))
  if [ "$MODE" = public ]; then setv "SHOWN_$i" "agent-$i"; else setv "SHOWN_$i" "$c"; fi
  pid=$("$DOCKER" inspect --format '{{.State.Pid}}' "$c" 2>/dev/null) || pid=''
  dir=''
  if is_number "$pid" && [ "$pid" -gt 0 ] && [ -r "$PROC/$pid/cgroup" ]; then
    path=$(sed -n 's/^0:://p' "$PROC/$pid/cgroup" | sed -n '1p')
    case $path in
      ''|/) ;;  # no cgroup v2 line, or this script is itself in a container and cannot see the host's tree
      *) [ -r "$CGROUP$path/memory.current" ] && [ -r "$CGROUP$path/memory.stat" ] && dir=$CGROUP$path ;;
    esac
  fi
  if [ -n "$dir" ]; then setv "SOURCE_$i" host; elif [ -n "$INSIDE" ]; then setv "SOURCE_$i" inside; else setv "SOURCE_$i" stats; fi
  setv "DIR_$i" "$dir"; setv "SEEN_$i" ''; setv "READ_$i" 0; setv "BEST_$i" ''
done

# One look at one container. Sets L_USE (KiB in use, empty when it could not be read) and what it was made from.
look_at() {
  L_USE=''; L_CURRENT=''; L_INACTIVE=''; L_STAT=''; L_ROW=''
  case $(getv "SOURCE_$1") in
    host)
      L_CURRENT=$(cat "$(getv "DIR_$1")/memory.current" 2>/dev/null) || L_CURRENT=''
      L_STAT=$(cat "$(getv "DIR_$1")/memory.stat" 2>/dev/null) || L_STAT='' ;;
    inside)
      both=$("$DOCKER" exec "$2" cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.stat 2>/dev/null) || both=''
      L_CURRENT=$(printf '%s\n' "$both" | sed -n '1p'); L_STAT=$(printf '%s\n' "$both" | sed '1d') ;;
    *)
      L_ROW=$(stats_row "$2") || L_ROW=''
      usage=${L_ROW%%|*}; L_USE=$(to_kib "${usage%%/*}")
      return ;;
  esac
  is_number "$L_CURRENT" && [ -n "$L_STAT" ] || return
  L_INACTIVE=$(stat_value inactive_file "$L_STAT"); [ -n "$L_INACTIVE" ] || L_INACTIVE=0
  # The same rule docker stats uses: file memory the kernel gives back first is not counted.
  if [ "$L_INACTIVE" -lt "$L_CURRENT" ]; then L_USE=$(((L_CURRENT - L_INACTIVE) / 1024)); else L_USE=$((L_CURRENT / 1024)); fi
}

# `docker top` rows -> "pid|resident KiB|program". The only place a command line becomes text that is
# printed: the program's base name and nothing after it (a path or an argument can carry a folder
# name or a secret). In public mode not even the name: only whether it is Node.
# shellcheck disable=SC2016  # an awk program, not shell
PROCESS_ROWS='
NR > 1 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && NF >= 3 {
  name = $3; sub(/.*\//, "", name); node = (name == "node" || name == "nodejs")
  if (mode == "public") name = node ? "Node process" : "other process"
  else if (name == "" || name ~ /[=@|]/) name = "[hidden]"
  else if (length(name) > 40) name = substr(name, 1, 37) "..."
  print $1 "|" $2 "|" name
}'

DATA=''; SUMMARY=''; TOTAL_KIB=0; COUNTED=0
add_data() { DATA="$DATA
$1"; }

block() {
  i=$1; c=$2; shown=$(getv "SHOWN_$i"); source=$(getv "SOURCE_$i")
  best=$(getv "BEST_$i"); read_count=$(getv "READ_$i"); stat=$(getv "STAT_$i")
  printf '\n== %s ==\n' "$shown"

  # 1. memory in use (the highest look) and the limit
  printf '\n1. Memory in use, and the limit\n'
  row=''
  if [ "$source" = stats ]; then row=$(getv "ROW_$i"); else row=$(stats_row "$c") || row=''; fi
  usage=${row%%|*}; docker_percent=$(printf '%s' "${row#*|}" | tr -d ' ')
  docker_kib=$(to_kib "${usage%%/*}"); limit_kib=$(to_kib "${usage##*/}")
  used_text='not available'; limit_text='-'; percent='-'; docker_text='-'
  [ -z "$limit_kib" ] || limit_text="$(kib_mib "$limit_kib") MiB"
  if [ -n "$best" ]; then
    used_text="$(kib_mib "$best") MiB"
    printf '     %s in use: the highest of %s looks %s seconds apart\n' "$used_text" "$LOOKS" "$GAP"
    printf '       the looks: %s\n' "$(printf '%s\n' "$(getv "SEEN_$i")" | awk '{ for (j = 1; j <= NF; j++) printf "%s%s", (j > 1 ? ", " : ""), ($j == "-" ? "not read" : sprintf("%.1f MiB", $j / 1024)); print "" }')"
    [ "$read_count" -eq "$LOOKS" ] || printf '       only %s of the %s looks could be read: %s\n' "$read_count" "$LOOKS" "$(why "$c" "a later look")"
    if [ "$source" = stats ]; then
      printf '       source: docker stats, which shows memory.current less inactive_file\n'
    else
      printf '       how it is counted: memory.current less inactive_file (%s MiB less %s MiB at the highest look)\n' "$(bytes_mib "$(getv "CURRENT_$i")")" "$(bytes_mib "$(getv "INACTIVE_$i")")"
      printf '       source: %s\n' "$(source_text "$source")"
    fi
    TOTAL_KIB=$((TOTAL_KIB + best)); COUNTED=$((COUNTED + 1))
    add_data "@total $best ${limit_kib:--} $shown"
    [ -z "$limit_kib" ] || percent=$(awk -v u="$best" -v l="$limit_kib" 'BEGIN { if (l > 0) printf "%.1f%%", u * 100 / l; else printf "-" }')
  else
    case $source in host) asked='the host'\''s cgroup files' ;; inside) asked='the command inside the container' ;; *) asked='docker stats' ;; esac
    printf '     not available: %s\n' "$(why "$c" "$asked")"
  fi
  if [ "$source" != stats ]; then
    if [ -n "$docker_kib" ] && [ -n "$limit_kib" ]; then
      docker_text="$(kib_mib "$docker_kib") MiB"
      printf '     %s of a %s limit (%s): what docker stats said a moment later\n' "$docker_text" "$limit_text" "${docker_percent:-?}"
    else
      printf '     docker stats figure and limit: not available: %s\n' "$(why "$c" 'docker stats')"
    fi
  elif [ -n "$best" ]; then
    docker_text=$used_text
    printf '     limit: %s (%s in use at the highest look, by docker stats)\n' "$limit_text" "${docker_percent:-?}"
  fi
  [ -z "$limit_kib" ] || printf '     (when a container has no limit of its own, Docker shows the whole server'\''s memory as the limit)\n'

  # 2. each process inside it
  printf '\n2. Processes inside it, with the memory each one holds\n'
  top=$("$DOCKER" top "$c" -o pid,rss,args 2>/dev/null) || top=''
  rows=$(printf '%s\n' "$top" | awk -v mode="$MODE" "$PROCESS_ROWS")
  if [ -n "$rows" ]; then
    printf '         PID       MEMORY  %s\n' "$([ "$MODE" = public ] && printf KIND || printf PROGRAM)"
    printf '%s\n' "$rows" | awk -F'|' '{ printf "     %7s  %7.1f MiB  %s\n", $1, $2 / 1024, $3 }'
    printf '     (processes share some memory, so these need not add up to the memory in use)\n'
    printf '     source: docker top (resident memory, as the server sees each process)\n'
    proc_count=$(printf '%s\n' "$rows" | awk 'END { print NR }')
    largest="$(printf '%s\n' "$rows" | awk -F'|' '$2 + 0 > m { m = $2 + 0 } END { printf "%.1f", m / 1024 }') MiB"
    # For --compare: one line per program name, because process numbers change when a container restarts.
    procs=$(printf '%s\n' "$rows" | awk -F'|' -v c="$shown" '
      { if (!($3 in kib)) order[++n] = $3; kib[$3] += $2; count[$3]++ }
      END { for (j = 1; j <= n; j++) print "@proc", kib[order[j]], count[order[j]], c, order[j] }')
    add_data "$procs"
  else
    proc_count='-'; largest='-'
    printf '     not available: %s\n' "$(why "$c" 'docker top')"
  fi

  # 3. what the memory is made of, from the container's cgroup files at the highest look
  printf '\n3. What the memory is made of (the container'\''s own accounting, at the highest look)\n'
  shmem_text='-'; peak_text='-'
  if [ -n "$stat" ]; then
    for key in anon file inactive_file shmem kernel sock; do
      case $key in
        anon) meaning='memory the programs themselves hold' ;;
        file) meaning='files kept in memory for speed; given back when memory runs short' ;;
        inactive_file) meaning='the part of "file" that is given back first; not counted as in use' ;;
        shmem) meaning='files in memory-backed folders such as /tmp; not given back' ;;
        kernel) meaning='the operating system'\''s bookkeeping for this container' ;;
        *) meaning='network buffers' ;;
      esac
      value=$(stat_value "$key" "$stat")
      if [ -n "$value" ]; then
        printf '     %-15s %8s MiB   %s\n' "$key" "$(bytes_mib "$value")" "$meaning"
        [ "$key" = shmem ] && shmem_text="$(bytes_mib "$value") MiB"
      else
        printf '     %-15s not available (this line is not in memory.stat here)\n' "$key"
      fi
    done
    printf '     %-15s %8s MiB   %s\n' memory.current "$(bytes_mib "$(getv "CURRENT_$i")")" 'everything, counting all the files kept in memory'
    case $source in
      host) peak=$(cat "$(getv "DIR_$i")/memory.peak" 2>/dev/null) || peak='' ;;
      *) peak=$("$DOCKER" exec "$c" cat /sys/fs/cgroup/memory.peak 2>/dev/null) || peak='' ;;
    esac
    if is_number "$peak"; then
      peak_text="$(bytes_mib "$peak") MiB"
      printf '     %-15s %8s MiB   %s\n' memory.peak "$(bytes_mib "$peak")" 'the highest it has been since the container started'
    else
      printf '     %-15s not available (the file is missing or could not be read; older kernels do not have it)\n' memory.peak
    fi
    printf '     source: %s\n' "$(source_text "$source")"
  elif [ "$source" = stats ]; then
    printf '     not available: the container'\''s cgroup files cannot be read from this host (it may need root,\n'
    printf '     the server may use an older cgroup layout, or Docker may keep containers in a virtual machine).\n'
    printf '     With --inside they are read by a short command started inside the container.\n'
  else
    case $source in host) asked='the host'\''s cgroup files' ;; *) asked='the command inside the container' ;; esac
    printf '     not available: %s\n' "$(why "$c" "$asked")"
  fi

  # 4. memory-backed folders. By default this is the shmem line; df runs inside the container only when asked.
  printf '\n4. Memory held by files in /tmp and other memory-backed folders\n'
  if [ "$shmem_text" != - ]; then
    printf '     %s: the shmem line above, from %s\n' "$shmem_text" "$(source_text "$source")"
  else
    printf '     not available: it is the shmem line of section 3, which could not be read\n'
  fi
  if [ -n "$INSIDE" ]; then
    disk=$("$DOCKER" exec "$c" df -h /tmp 2>/dev/null) || disk=''
    filled=$(printf '%s\n' "$disk" | awk 'END { if (NF >= 5 && $(NF - 1) ~ /^[0-9]+%$/ && $(NF - 3) ~ /^[0-9.]+[A-Za-z]*$/) print $(NF - 3) " used, " $(NF - 1) " full" }')
    if [ -z "$filled" ]; then
      printf '     how full /tmp is: not available: %s\n' "$(why "$c" 'df inside the container')"
    elif [ "$MODE" = public ]; then
      printf '     how full /tmp is: %s (source: df, started inside the container with --inside)\n' "$filled"
    else
      printf '     how full /tmp is, as df inside the container prints it (started with --inside):\n'
      printf '%s\n' "$disk" | sed 's/^/       /'
    fi
  else
    printf '     how full /tmp is: not looked at (df would have to be started inside the container; --inside does that)\n'
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
    printf '     not available (no Node process was found in this container; source: docker top)\n'
  elif [ "${node#* }" != - ]; then
    printf '     %s MiB (set with --max-old-space-size on the command line of the largest Node process, PID %s; source: docker top)\n' "${node#* }" "${node%% *}"
  else
    setting=$("$DOCKER" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null |
      sed -n 's/^NODE_OPTIONS=.*--max[-_]old[-_]space[-_]size=\([0-9][0-9]*\).*/\1/p' | sed -n '1p')
    if [ -n "$setting" ]; then
      printf '     %s MiB (set with --max-old-space-size in the container'\''s NODE_OPTIONS setting; source: docker inspect)\n' "$setting"
    else
      printf '     not available (no --max-old-space-size is set, so Node chose its own default; reading that\n'
      printf '     would mean starting a second Node process inside the container, which this script does not do)\n'
    fi
  fi

  SUMMARY="$SUMMARY
$(printf '  %-34s %12s %13s %12s %9s %10s %16s %12s %12s' "$shown" "$used_text" "$docker_text" "$limit_text" "$percent" "$proc_count" "$largest" "$shmem_text" "$peak_text")"
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
  printf "  older: taken %s, label %s%s\n", taken["old"], label["old"], (file == "" ? "" : " (" file ")")
  printf "  now:   taken %s, label %s\n", taken["new"], label["new"]
  for (i = 1; i <= nn; i++) {
    c = names[i]
    if (!(("new", c) in total)) { gone = gone " " c; continue }
    printf "\n  %s\n", c
    if (!(("old", c) in total)) { printf "    not in the older file, so there is nothing to compare with\n"; continue }
    printf "    %-44s %s\n", "in use", change(total["old", c], total["new", c])
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
  if [ "$MODE" = public ]; then
    printf 'Mode:   public (containers are numbered; no container name, program name, path or folder is printed)\n'
  else
    printf 'Mode:   normal (container names and program names are printed; use --public for output to share)\n'
  fi
  printf 'Method: "in use" is memory.current less inactive_file, the highest of %s looks %s seconds apart\n' "$LOOKS" "$GAP"
  if [ -n "$INSIDE" ]; then
    printf 'Started inside the containers: short read-only commands (cat, df), because --inside was given\n'
  else
    printf 'Started inside the containers: nothing\n'
  fi
  shown_list=''; i=0
  for c in "$@"; do i=$((i + 1)); shown_list="$shown_list $(getv "SHOWN_$i")"; done
  printf 'Containers measured (%s):%s\n' "$COUNT" "$shown_list"
  if [ -n "$NAMES" ]; then
    if [ "$MISSING_COUNT" -gt 0 ]; then
      if [ "$MODE" = public ]; then printf 'Named but not running, so not measured: %s container(s)\n' "$MISSING_COUNT"
      else printf 'Named but not running, so not measured:%s\n' "$MISSING"; fi
    fi
  else
    printf 'Every running container whose name starts with "%s" is included, which can be more than the\n' "$PREFIX"
    printf 'agents. To measure only some of them, give their names after the command.\n'
  fi
  printf 'Nothing on this machine was changed. Memory is shown in MiB (1024 MiB = 1 GiB).\n'
  add_data "@taken $TAKEN"; add_data "@label $LABEL"; add_data "@mode $MODE"

  i=0
  for c in "$@"; do i=$((i + 1)); block "$i" "$c"; done

  printf '\n== Summary ==\n\n'
  printf '  %-34s %12s %13s %12s %9s %10s %16s %12s %12s\n' CONTAINER 'IN USE' 'DOCKER STATS' LIMIT 'OF LIMIT' PROCESSES 'LARGEST PROCESS' SHMEM PEAK
  printf '%s\n' "${SUMMARY#?}"
  printf '\n  Total in use, %s of %s container(s): %s MiB\n' "$COUNTED" "$COUNT" "$(kib_mib "$TOTAL_KIB")"
  [ "$COUNTED" -eq "$COUNT" ] || printf '  (the total leaves out the containers that could not be read; their blocks above say why)\n'

  if [ -n "$COMPARE" ]; then
    shown_file=$COMPARE; [ "$MODE" = public ] && shown_file=''
    printf '%s\n' "$DATA" | awk -v file="$shown_file" "$COMPARE_LINES" src=old "$COMPARE" src=new -
  fi

  printf '\n----- The same numbers once more, in KiB, for --compare. You can ignore these lines. -----\n'
  printf '%s\n' "${DATA#?}"
}

printf 'Measuring %s container(s): %s looks %s seconds apart, so this takes a little while.\n' "$COUNT" "$LOOKS" "$GAP" >&2
TAKEN=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
look=0
while [ "$look" -lt "$LOOKS" ]; do
  look=$((look + 1))
  [ "$look" -eq 1 ] || "$SLEEP" "$GAP"
  i=0
  for c in "$@"; do
    i=$((i + 1))
    look_at "$i" "$c"
    if [ -n "$L_USE" ]; then
      setv "SEEN_$i" "$(getv "SEEN_$i") $L_USE"; setv "READ_$i" "$(($(getv "READ_$i") + 1))"
      best=$(getv "BEST_$i")
      if [ -z "$best" ] || [ "$L_USE" -gt "$best" ]; then
        setv "BEST_$i" "$L_USE"; setv "CURRENT_$i" "$L_CURRENT"; setv "INACTIVE_$i" "$L_INACTIVE"; setv "STAT_$i" "$L_STAT"; setv "ROW_$i" "$L_ROW"
      fi
    else
      setv "SEEN_$i" "$(getv "SEEN_$i") -"
    fi
  done
done
RESULT=$(report "$@")
printf '%s\n' "$RESULT"

if [ -n "$OUT" ]; then
  saved="$OUT/agent-memory-$(date -u '+%Y%m%dT%H%M%SZ')-$FILE_LABEL.txt"
  mkdir -p "$OUT" 2>/dev/null || stop "The measurement above could not be saved: the folder given with --out could not be made."
  printf '%s\n' "$RESULT" > "$saved" || stop "The measurement above could not be saved in the folder given with --out."
  # Not part of the saved file. In public mode the path is left out: it can carry a folder or user name.
  if [ "$MODE" = public ]; then printf '\nSaved in the folder given with --out.\n'
  else printf '\nSaved as %s\n' "$saved"; fi
fi
