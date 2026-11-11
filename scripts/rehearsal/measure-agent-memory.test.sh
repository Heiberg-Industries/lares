#!/bin/sh
# Test for measure-agent-memory.sh. Needs no Docker and waits for nothing: the script is pointed at
# stand-ins for the docker and sleep commands and at made-up /proc and cgroup folders.
#
#   sh scripts/rehearsal/measure-agent-memory.test.sh
#
# It checks the four looks and the highest of them, reading the cgroup files from the host side, that
# nothing is started inside a container unless --inside is given, one container vanishing while the
# others still report, the summary, the compare mode, the saved file, that --public prints none of
# the made-up names, paths or arguments, and the sentences for "no containers" and "no Docker".
# Everything it writes goes into a temporary folder that it removes again. What it cannot check is
# what a real Docker and a real kernel print: only a run on an install shows that.
set -u
here=$(cd "$(dirname "$0")" && pwd)
script="$here/measure-agent-memory.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/measure-agent-memory-test.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
state="$work/state"
MIB=1048576

# The made-up install. Three containers plus one whose name does not start with "lares-":
#   lares-example-one    a launcher and a Node server (heap limit on its command line); cgroup files
#                        readable from the host; the highest of its four looks is the second one
#   lares-example-two    a Node server; host-readable; no memory.peak and no "kernel" line (older kernel)
#   lares-example-three  no Node; its cgroup folder is NOT on the host, so only docker stats (or, with
#                        --inside, a command inside the container) can read it
# Every name, path and argument that must never be printed contains the word "made-up".
# Scenarios: start, later (for compare), vanish (two disappears after the second look),
# gone (two disappears right after the listing), none (nothing matching runs), down (Docker does not answer).
fresh() {
  rm -rf "$state" "$work/proc" "$work/cgroup"
  one="$work/cgroup/system.slice/docker-aaa.scope"; two="$work/cgroup/system.slice/docker-bbb.scope"
  mkdir -p "$state" "$one" "$two" "$work/proc/4242" "$work/proc/6100" "$work/proc/7000"
  printf '%s\n' "$1" > "$state/scenario"; echo 1 > "$state/look"; : > "$state/calls"; : > "$state/pauses"
  printf '12:memory:/docker/aaa\n0::/system.slice/docker-aaa.scope\n' > "$work/proc/4242/cgroup"
  printf '0::/system.slice/docker-bbb.scope\n' > "$work/proc/6100/cgroup"
  printf '0::/system.slice/docker-ccc.scope\n' > "$work/proc/7000/cgroup"
  if [ "$1" = later ]; then set -- 500 518 510 490 94; else set -- 420 432 425 410 100; fi
  look=0
  for megabytes in "$1" "$2" "$3" "$4"; do
    look=$((look + 1))
    echo $((megabytes * MIB)) > "$one/memory.current.$look"; echo $(($5 * MIB)) > "$two/memory.current.$look"
  done
  cp "$one/memory.current.1" "$one/memory.current"; cp "$two/memory.current.1" "$two/memory.current"
  printf '%s\n' "anon $((400 * MIB))" "file $((30 * MIB))" 'kernel 6396313' 'kernel_stack 163840' 'sock 104858' \
    "shmem $((2 * MIB))" "active_file $((10 * MIB))" "inactive_file $((20 * MIB))" > "$one/memory.stat"
  echo 555955814 > "$one/memory.peak"
  printf '%s\n' "anon $((80 * MIB))" "file $((6 * MIB))" 'sock 0' 'shmem 0' "inactive_file $((4 * MIB))" > "$two/memory.stat"
  if [ "$(cat "$state/scenario")" = gone ]; then rm -rf "$two"; : > "$state/gone-two"; fi
}

cat > "$work/docker" <<'STAND_IN'
#!/bin/sh
state=$FAKE_ROOT/state
scenario=$(cat "$state/scenario"); look=$(cat "$state/look")
printf '%s\n' "$*" >> "$state/calls"
command=${1:-}
[ $# -gt 0 ] && shift
case " $* " in
  *' lares-example-two '*) [ -e "$state/gone-two" ] && { echo 'Error response from daemon: No such container: lares-example-two' >&2; exit 1; } ;;
esac
case $command in
  ps)
    case $scenario in
      down) echo 'Cannot connect to the Docker daemon.' >&2; exit 1 ;;
      none) echo other-thing ;;
      *) printf '%s\n' lares-example-two other-thing lares-example-one lares-example-three ;;
    esac ;;
  stats)
    case $4 in
      lares-example-one) if [ "$scenario" = later ]; then echo '498.5MiB / 1GiB|48.68%'; else echo '412.3MiB / 1GiB|40.26%'; fi ;;
      lares-example-two) if [ "$scenario" = later ]; then echo '90MiB / 1GiB|8.79%'; else echo '96MiB / 1GiB|9.38%'; fi ;;
      lares-example-three) case $look in 2) echo '160MiB / 2GiB|7.81%' ;; 3) echo '155MiB / 2GiB|7.57%' ;; *) echo '150MiB / 2GiB|7.32%' ;; esac ;;
      *) exit 1 ;;
    esac ;;
  top)
    echo 'PID                 RSS                 COMMAND'
    case $1 in
      lares-example-one)
        echo '4242                1536                /bin/sh /srv/made-up-folder/launcher --token made-up-secret-argument'
        if [ "$scenario" = later ]; then
          echo '4290                470016              /opt/made-up-folder/bin/node --max-old-space-size=768 /app/server.js --api-key=made-up-secret-flag'
          echo '5001                20480               /usr/bin/python3 /srv/made-up-folder/helper.py'
        else
          echo '4290                389120              /opt/made-up-folder/bin/node --max-old-space-size=768 /app/server.js --api-key=made-up-secret-flag'
        fi ;;
      lares-example-two)
        if [ "$scenario" = later ]; then rss=76800; else rss=81920; fi
        echo "6100                $rss               node /app/server.js postgres://user:made-up-secret-url@db/x" ;;
      lares-example-three)
        echo '7000                102400              postgres -D /srv/made-up-folder/data'
        echo '7001                4096                postgres: made-up-role made-up-database'
        echo '7002                4096                postgres: made-up-role made-up-database' ;;
    esac ;;
  exec)
    case "$*" in
      'lares-example-three cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.stat')
        printf '%s\n' 178257920 'anon 157286400' 'file 12582912' 'inactive_file 10485760' 'shmem 4194304' 'kernel 1048576' 'sock 0' ;;
      'lares-example-three cat /sys/fs/cgroup/memory.peak') echo 209715200 ;;
      'lares-example-three df -h /tmp')
        echo 'Filesystem             Size  Used Avail Use% Mounted on'
        echo 'made-up-device          64M  4.0M   60M   7% /tmp' ;;
      'lares-example-one df -h /tmp')
        echo 'Filesystem      Size  Used Avail Use% Mounted on'
        echo 'tmpfs           7.8G  2.0M  7.8G   1% /tmp' ;;
      *) echo 'cat: no such file or directory' >&2; exit 1 ;;
    esac ;;
  inspect)
    case $2 in
      *State.Pid*) case $3 in lares-example-one) echo 4242 ;; lares-example-two) echo 6100 ;; lares-example-three) echo 7000 ;; *) exit 1 ;; esac ;;
      *State.Running*) echo true ;;
      *)
        echo 'PATH=/usr/local/bin:/usr/bin'
        echo 'API_TOKEN=made-up-secret-setting'
        [ "$scenario" = later ] && [ "$3" = lares-example-two ] && echo 'NODE_OPTIONS=--enable-source-maps --max-old-space-size=512'
        exit 0 ;;
    esac ;;
  *) echo "stand-in docker: unexpected command $command" >&2; exit 64 ;;
esac
STAND_IN

# The stand-in for sleep waits for nothing. It notes how long it was asked to wait and moves the
# made-up install on to its next look.
cat > "$work/sleep" <<'STAND_IN'
#!/bin/sh
state=$FAKE_ROOT/state
printf '%s\n' "$*" >> "$state/pauses"
look=$(($(cat "$state/look") + 1)); echo "$look" > "$state/look"
for folder in "$FAKE_ROOT"/cgroup/system.slice/*.scope; do
  [ -f "$folder/memory.current.$look" ] && cp "$folder/memory.current.$look" "$folder/memory.current"
done
if [ "$(cat "$state/scenario")" = vanish ] && [ "$look" -eq 3 ]; then
  rm -rf "$FAKE_ROOT/cgroup/system.slice/docker-bbb.scope"; : > "$state/gone-two"
fi
exit 0
STAND_IN
chmod +x "$work/docker" "$work/sleep"

passed=0; failed=0
ok() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
bad() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; }
# has <what> <text> <extended regular expression>
has() { if printf '%s\n' "$2" | grep -Eq -e "$3"; then ok "$1"; else bad "$1 (no line matches: $3)"; fi; }
lacks() { if printf '%s\n' "$2" | grep -Eq -e "$3"; then bad "$1 (a line matches: $3)"; else ok "$1"; fi; }
lacks_text() { if printf '%s\n' "$2" | grep -Fq -e "$3"; then bad "$1 (found: $3)"; else ok "$1"; fi; }
is() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got $2, wanted $3)"; fi; }
run() {
  FAKE_ROOT="$work" LARES_MEASURE_DOCKER="$work/docker" LARES_MEASURE_SLEEP="$work/sleep" \
    LARES_MEASURE_PROC="$work/proc" LARES_MEASURE_CGROUP="$work/cgroup" sh "$script" "$@"
}
# measure: what the script prints as its result. refused: the same call, with what it says when it stops.
measure() { run "$@" 2>/dev/null; }
refused() { run "$@" 2>&1; }

if sh -n "$script"; then ok 'the script parses'; else bad 'the script parses'; fi

# --- a plain run, saved ------------------------------------------------------------------------
fresh start
out=$(measure --label after-start --out "$work/saved"); code=$?
is 'a run succeeds' "$code" 0
has 'the header says when' "$out" '^Taken:  [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC$'
has 'the header carries the label' "$out" '^Label:  after-start$'
has 'the header names the mode' "$out" '^Mode:   normal '
has 'the header names the method' "$out" '^Method: "in use" is memory\.current less inactive_file, the highest of 4 looks 2 seconds apart$'
has 'the header says nothing was started inside' "$out" '^Started inside the containers: nothing$'
has 'only names starting with lares- are measured, in order' "$out" '^Containers measured \(3\): lares-example-one lares-example-three lares-example-two$'
lacks 'other containers are left alone' "$out" 'other-thing'

is 'four looks mean three pauses of 2 seconds' "$(tr '\n' ' ' < "$state/pauses")" '2 2 2 '
lacks 'nothing is started inside a container by default' "$(cat "$state/calls")" '^exec '

has 'the headline is the highest look, not the first or the last' "$out" '^ +412\.0 MiB in use: the highest of 4 looks 2 seconds apart$'
has 'all four looks are shown' "$out" '^ +the looks: 400\.0 MiB, 412\.0 MiB, 405\.0 MiB, 390\.0 MiB$'
has 'the headline is memory.current less inactive_file' "$out" '^ +how it is counted: memory\.current less inactive_file \(432\.0 MiB less 20\.0 MiB at the highest look\)$'
has 'the headline says it came from the host' "$out" '^ +source: the host.s cgroup files \(nothing was started in the container\)$'
has 'the docker stats figure is printed beside it' "$out" '^ +412\.3 MiB of a 1024\.0 MiB limit \(40\.26%\): what docker stats said a moment later$'
has 'a container the host cannot read falls back to four looks at docker stats' "$out" '^ +the looks: 150\.0 MiB, 160\.0 MiB, 155\.0 MiB, 150\.0 MiB$'
has 'and says that docker stats is the source' "$out" '^ +source: docker stats, which shows memory\.current less inactive_file$'
has 'and says why there is no breakdown' "$out" '^ +not available: the container.s cgroup files cannot be read from this host'

has 'the launcher shows as its own process, by program name only' "$out" '^ +4242 +1\.5 MiB  sh$'
has 'the server shows as its own process, by program name only' "$out" '^ +4290 +380\.0 MiB  node$'
has 'a process title keeps only its first word' "$out" '^ +7001 +4\.0 MiB  postgres:$'
lacks 'no path, argument, secret or setting is printed' "$out" 'made-up|API_TOKEN|PATH='
has 'processes name their source' "$out" '^ +source: docker top '
has 'anon from memory.stat' "$out" '^ +anon +400\.0 MiB'
has 'inactive_file is printed' "$out" '^ +inactive_file +20\.0 MiB'
has 'shmem from memory.stat' "$out" '^ +shmem +2\.0 MiB'
has 'kernel is the kernel line, not kernel_stack' "$out" '^ +kernel +6\.1 MiB'
has 'a line missing from memory.stat is skipped cleanly' "$out" '^ +kernel +not available'
has 'memory.current at the highest look' "$out" '^ +memory\.current +432\.0 MiB'
has 'memory.peak when present' "$out" '^ +memory\.peak +530\.2 MiB'
has 'memory.peak when the file is missing' "$out" '^ +memory\.peak +not available'
has '/tmp is taken from shmem' "$out" '^ +2\.0 MiB: the shmem line above, from the host.s cgroup files '
has 'df is not run by default' "$out" '^ +how full /tmp is: not looked at '
has 'heap limit from the command line' "$out" '^ +768 MiB \(set with --max-old-space-size on the command line of the largest Node process, PID 4290; source: docker top\)$'
has 'heap limit when none is set' "$out" '^ +not available \(no --max-old-space-size is set'
has 'heap limit when there is no Node' "$out" '^ +not available \(no Node process'
has 'summary line, first container' "$out" '^  lares-example-one +412\.0 MiB +412\.3 MiB +1024\.0 MiB +40\.2% +2 +380\.0 MiB +2\.0 MiB +530\.2 MiB$'
has 'summary line, second container' "$out" '^  lares-example-two +96\.0 MiB +96\.0 MiB +1024\.0 MiB +9\.4% +1 +80\.0 MiB +0\.0 MiB +-$'
has 'summary line, container read through docker stats' "$out" '^  lares-example-three +160\.0 MiB +160\.0 MiB +2048\.0 MiB +7\.8% +3 +100\.0 MiB +- +-$'
has 'the total' "$out" '^  Total in use, 3 of 3 container\(s\): 668\.0 MiB$'

saved=$(ls "$work/saved")
has 'the saved file is named after the time and the label' "$saved" '^agent-memory-[0-9]{8}T[0-9]{6}Z-after-start\.txt$'
is 'exactly one file is saved' "$(printf '%s\n' "$saved" | wc -l | tr -d ' ')" 1
older="$work/saved/$saved"
# What was printed ends with an empty line and the "Saved as" line; the file holds everything before those.
is 'the saved file holds what was printed' "$(cat "$older")" "$(printf '%s\n' "$out" | sed '$d' | sed '$d')"
has 'the run says where it saved' "$out" "^Saved as $work/saved/agent-memory-"

# --- compare with the saved file ---------------------------------------------------------------
fresh later
out=$(measure --label after-chat --compare "$older"); code=$?
is 'a compare run succeeds' "$code" 0
has 'compare names the older measurement' "$out" '^  older: taken .* UTC, label after-start \('
has 'compare names this measurement' "$out" '^  now:   taken .* UTC, label after-chat$'
has 'compare: memory in use grew' "$out" '^    in use +412\.0 MiB -> +498\.0 MiB   \+86\.0 MiB$'
has 'compare: the server grew' "$out" '^    node +380\.0 MiB -> +459\.0 MiB   \+79\.0 MiB$'
has 'compare: the launcher did not change' "$out" '^    sh +1\.5 MiB -> +1\.5 MiB   \+0\.0 MiB$'
has 'compare: a program that was not there before' "$out" '^    python3 +- -> +20\.0 MiB   new since then$'
has 'compare: memory in use shrank' "$out" '^    in use +96\.0 MiB -> +90\.0 MiB   -6\.0 MiB$'
has 'compare: same-named processes are added up' "$out" '^    postgres: +8\.0 MiB -> +8\.0 MiB   \+0\.0 MiB \(x2\)$'
has 'compare: all containers together' "$out" '^  All 3 container\(s\) in both measurements +668\.0 MiB -> +748\.0 MiB   \+80\.0 MiB$'
has 'heap limit from the NODE_OPTIONS setting' "$out" '^ +512 MiB \(set with --max-old-space-size in the container.s NODE_OPTIONS setting; source: docker inspect\)$'
lacks 'compare prints no path, argument, secret or setting either' "$out" 'made-up|API_TOKEN'

fresh later
out=$(measure --compare "$older" lares-example-two); code=$?
is 'a compare run for one named container succeeds' "$code" 0
has 'compare: a container measured before but not now is named' "$out" '^  In the older file but not measured now: lares-example-one lares-example-three$'

fresh start
out=$(refused --compare "$script"); code=$?
is 'comparing with a file that is no measurement stops' "$code" 1
has 'and says so' "$out" 'is not a measurement saved by this script'
out=$(refused --public --compare "$older"); code=$?
is 'comparing a public run with a normal file stops' "$code" 1
has 'and says the modes differ' "$out" 'was made in normal mode and this run is in public mode'

# --- one container vanishes during the run ------------------------------------------------------
fresh vanish
out=$(measure); code=$?
is 'a run in which a container vanishes after two looks still succeeds' "$code" 0
has 'vanished: the looks that were read are shown, the others marked' "$out" '^ +the looks: 96\.0 MiB, 96\.0 MiB, not read, not read$'
has 'vanished: the output says why looks are missing' "$out" '^ +only 2 of the 4 looks could be read: the container stopped or was removed while it was being measured$'
has 'vanished: docker stats is missing with the reason' "$out" '^ +docker stats figure and limit: not available: the container stopped or was removed while it was being measured$'
has 'vanished: the others still report their looks' "$out" '^ +the looks: 400\.0 MiB, 412\.0 MiB, 405\.0 MiB, 390\.0 MiB$'
has 'vanished: the others still report docker stats' "$out" '^ +412\.3 MiB of a 1024\.0 MiB limit \(40\.26%\): what docker stats said a moment later$'
has 'vanished: the others still report in the summary' "$out" '^  lares-example-three +160\.0 MiB +160\.0 MiB +2048\.0 MiB '
has 'vanished: its summary line keeps what was read' "$out" '^  lares-example-two +96\.0 MiB +- +- +- +- +- +0\.0 MiB +-$'

fresh gone
out=$(measure); code=$?
is 'a run in which a container vanishes right after the listing still succeeds' "$code" 0
has 'gone: its figure is missing with the reason' "$out" '^ +not available: the container stopped or was removed while it was being measured$'
has 'gone: the others still report' "$out" '^  lares-example-one +412\.0 MiB +412\.3 MiB +1024\.0 MiB '
has 'gone: its summary line says not available' "$out" '^  lares-example-two +not available +- +- +- +- +- +- +-$'
has 'gone: the total says what it covers' "$out" '^  Total in use, 2 of 3 container\(s\): 572\.0 MiB$'
has 'gone: the total says what it leaves out' "$out" '^  \(the total leaves out the containers that could not be read'

# --- --inside ----------------------------------------------------------------------------------
fresh start
out=$(measure --inside); code=$?
is 'a run with --inside succeeds' "$code" 0
has 'inside: the header says commands were started' "$out" '^Started inside the containers: short read-only commands \(cat, df\), because --inside was given$'
has 'inside: the container the host cannot read is read inside' "$out" '^ +how it is counted: memory\.current less inactive_file \(170\.0 MiB less 10\.0 MiB at the highest look\)$'
has 'inside: and says so' "$out" '^ +source: a short command started inside the container \(--inside\)$'
has 'inside: its breakdown is there' "$out" '^ +shmem +4\.0 MiB'
has 'inside: its peak is there' "$out" '^ +memory\.peak +200\.0 MiB'
has 'inside: df is printed' "$out" '^ +made-up-device +64M +4\.0M +60M +7% /tmp$'
has 'inside: df that cannot be run says so' "$out" '^ +how full /tmp is: not available: the container is still running, but df inside the container gave nothing$'
lacks 'inside: a container the host can read is still read from the host' "$(cat "$state/calls")" '^exec lares-example-(one|two) cat '

# --- --public ----------------------------------------------------------------------------------
fresh start
out=$(measure --public --inside --label after-start --out "$work/public" lares-example-one lares-example-three lares-example-two lares-example-gone); code=$?
is 'a public run succeeds' "$code" 0
has 'public: the header names the mode' "$out" '^Mode:   public '
has 'public: containers are numbered in a stable order' "$out" '^Containers measured \(3\): agent-1 agent-2 agent-3$'
has 'public: a named container that is not running is counted, not named' "$out" '^Named but not running, so not measured: 1 container\(s\)$'
has 'public: blocks are numbered' "$out" '^== agent-2 ==$'
has 'public: a Node process is only called that' "$out" '^ +4290 +380\.0 MiB  Node process$'
has 'public: any other process is only called that' "$out" '^ +4242 +1\.5 MiB  other process$'
has 'public: df shows only how full' "$out" '^ +how full /tmp is: 4\.0M used, 7% full '
has 'public: the summary uses the numbers' "$out" '^  agent-1 +412\.0 MiB +412\.3 MiB +1024\.0 MiB '
has 'public: the run does not say where it saved' "$out" '^Saved in the folder given with --out\.$'
lacks 'public: no container name' "$out" 'lares-example|example-'
lacks 'public: no made-up name, path or argument' "$out" 'made-up|API_TOKEN|PATH='
lacks 'public: no program name' "$out" 'postgres|python|launcher|server\.js|/bin/|  (sh|node)$'
lacks_text 'public: no --out path' "$out" "$work"
lacks_text 'public: no host name' "$out" "$(uname -n)"
public_older="$work/public/$(ls "$work/public")"
lacks 'public: the saved file has no container name or made-up text' "$(cat "$public_older")" 'lares-example|made-up'

fresh later
out=$(measure --public --compare "$public_older"); code=$?
is 'a public compare run succeeds' "$code" 0
has 'public compare: by number' "$out" '^  agent-1$'
has 'public compare: memory in use' "$out" '^    in use +412\.0 MiB -> +498\.0 MiB   \+86\.0 MiB$'
has 'public compare: processes by kind' "$out" '^    Node process +380\.0 MiB -> +459\.0 MiB   \+79\.0 MiB$'
has 'public compare: other processes added up' "$out" '^    other process +1\.5 MiB -> +21\.5 MiB   \+20\.0 MiB \(x2\)$'
has 'public compare: the older file is described without its path' "$out" '^  older: taken .* UTC, label after-start$'
lacks_text 'public compare: no path of the older file' "$out" "$work"
lacks 'public compare: no name, path or argument' "$out" 'lares-example|made-up|python'

# --- names as arguments ------------------------------------------------------------------------
fresh start
out=$(measure lares-example-two lares-example-gone); code=$?
is 'a run for named containers succeeds' "$code" 0
has 'only the named container is measured' "$out" '^Containers measured \(1\): lares-example-two$'
has 'a named container that is not running is reported' "$out" '^Named but not running, so not measured: lares-example-gone$'
has 'the total covers only what was measured' "$out" '^  Total in use, 1 of 1 container\(s\): 96\.0 MiB$'
has 'no label is shown as none' "$out" '^Label:  \(none\)$'

# --- nothing to measure ------------------------------------------------------------------------
fresh none
out=$(refused); code=$?
is 'no matching container: stops' "$code" 1
has 'no matching container: one clear sentence' "$out" '^No running container has a name that starts with "lares-"\. Nothing was measured\.$'

fresh start
out=$(refused lares-example-gone); code=$?
is 'named containers all stopped: stops' "$code" 1
has 'named containers all stopped: one clear sentence' "$out" '^None of the containers you named is running: lares-example-gone\. Nothing was measured\.$'

out=$(LARES_MEASURE_DOCKER="$work/no-such-docker" sh "$script" 2>&1); code=$?
is 'no Docker: stops' "$code" 1
has 'no Docker: one clear sentence' "$out" '^Docker is not available here: .* Nothing was measured\.$'

fresh down
out=$(refused); code=$?
is 'Docker not answering: stops' "$code" 1
has 'Docker not answering: one clear sentence' "$out" '^Docker is installed but did not answer\..* Nothing was measured\.$'

fresh start
out=$(refused --frobnicate); code=$?
is 'an unknown option is refused' "$code" 2
out=$(refused 'lares-example-one;reboot'); code=$?
is 'something that is not a container name is refused' "$code" 2

printf '\n%s checks passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
