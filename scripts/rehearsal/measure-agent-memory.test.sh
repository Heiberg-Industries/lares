#!/bin/sh
# Test for measure-agent-memory.sh. Needs no Docker: the script is pointed at a stand-in command
# (LARES_MEASURE_DOCKER) that prints canned answers for made-up containers.
#
#   sh scripts/rehearsal/measure-agent-memory.test.sh
#
# It checks the summary, the compare mode, the saved file, what is hidden from command lines, and the
# sentences for "no containers" and "no Docker". Everything it writes goes into a temporary folder
# that it removes again. What it cannot check is what a real Docker prints: only a run on an install
# shows that.
set -u
here=$(cd "$(dirname "$0")" && pwd)
script="$here/measure-agent-memory.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/measure-agent-memory-test.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT

# The stand-in. Three made-up containers plus one whose name does not start with "lares-":
#   lares-example-one    a launcher and a Node server with the heap limit on its command line
#   lares-example-two    a Node server; no memory.peak file and no "kernel" line (an older kernel)
#   lares-example-three  no Node, and nothing can be run inside it
# FAKE_DOCKER_SCENARIO picks the moment: start (default), later, none (nothing matching runs), down.
cat > "$work/docker" <<'STAND_IN'
#!/bin/sh
scenario=${FAKE_DOCKER_SCENARIO:-start}
command=${1:-}
[ $# -gt 0 ] && shift
case $command in
  ps)
    case $scenario in
      down) echo 'Cannot connect to the Docker daemon.' >&2; exit 1 ;;
      none) echo other-thing ;;
      *) printf '%s\n' lares-example-two other-thing lares-example-one lares-example-three ;;
    esac ;;
  stats)
    if [ "$scenario" = later ]; then one=498MiB; two=90MiB; else one=412.3MiB; two=96MiB; fi
    for name in "$@"; do
      case $name in
        lares-example-one) echo "lares-example-one|$one / 1GiB|40.26%" ;;
        lares-example-two) echo "lares-example-two|$two / 1GiB|9.38%" ;;
        lares-example-three) echo 'lares-example-three|150MiB / 2GiB|7.32%' ;;
      esac
    done ;;
  top)
    echo 'PID                 RSS                 COMMAND'
    case $1 in
      lares-example-one)
        echo '4242                1536                /bin/sh /usr/local/bin/launcher --token made-up-secret-argument'
        if [ "$scenario" = later ]; then
          echo '4290                470016              node --max-old-space-size=768 /app/server.js --api-key=made-up-secret-flag'
          echo '5001                20480               node /app/worker.js'
        else
          echo '4290                389120              node --max-old-space-size=768 /app/server.js --api-key=made-up-secret-flag'
        fi ;;
      lares-example-two)
        if [ "$scenario" = later ]; then rss=76800; else rss=81920; fi
        echo "6100                $rss               /usr/local/bin/node /app/server.js postgres://user:made-up-secret-url@db/x" ;;
      lares-example-three)
        echo '7000                102400              postgres'
        echo '7001                4096                postgres: writer process'
        echo '7002                4096                postgres: writer process' ;;
    esac ;;
  exec)
    case "$*" in
      'lares-example-one cat /sys/fs/cgroup/memory.stat')
        printf '%s\n' 'anon 417542144' 'file 9961472' 'kernel 6396313' 'kernel_stack 163840' 'sock 104858' 'shmem 2097152' 'file_mapped 1234' ;;
      'lares-example-one cat /sys/fs/cgroup/memory.current') echo 435159040 ;;
      'lares-example-one cat /sys/fs/cgroup/memory.peak') echo 555955814 ;;
      'lares-example-one df -h /tmp')
        echo 'Filesystem      Size  Used Avail Use% Mounted on'
        echo 'tmpfs           7.8G  2.0M  7.8G   1% /tmp' ;;
      'lares-example-two cat /sys/fs/cgroup/memory.stat')
        printf '%s\n' 'anon 83886080' 'file 1048576' 'sock 0' 'shmem 0' ;;
      'lares-example-two cat /sys/fs/cgroup/memory.current') echo 100663296 ;;
      'lares-example-two df -h /tmp')
        echo 'Filesystem      Size  Used Avail Use% Mounted on'
        echo 'tmpfs           7.8G     0  7.8G   0% /tmp' ;;
      *) echo 'cat: no such file or directory' >&2; exit 1 ;;
    esac ;;
  inspect)
    echo 'PATH=/usr/local/bin:/usr/bin'
    echo 'API_TOKEN=made-up-secret-setting'
    [ "$scenario" = later ] && [ "$3" = lares-example-two ] && echo 'NODE_OPTIONS=--enable-source-maps --max-old-space-size=512'
    exit 0 ;;
  *) echo "stand-in docker: unexpected command $command" >&2; exit 64 ;;
esac
STAND_IN
chmod +x "$work/docker"

passed=0; failed=0
ok() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
bad() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; }
# has <what> <text> <extended regular expression>
has() { if printf '%s\n' "$2" | grep -Eq -e "$3"; then ok "$1"; else bad "$1 (no line matches: $3)"; fi; }
lacks() { if printf '%s\n' "$2" | grep -Eq -e "$3"; then bad "$1 (a line matches: $3)"; else ok "$1"; fi; }
is() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got $2, wanted $3)"; fi; }
# measure: what the script prints as its result. refused: the same call, with what it says when it stops.
measure() { LARES_MEASURE_DOCKER="$work/docker" sh "$script" "$@" 2>/dev/null; }
refused() { LARES_MEASURE_DOCKER="$work/docker" sh "$script" "$@" 2>&1; }

if sh -n "$script"; then ok 'the script parses'; else bad 'the script parses'; fi

# --- a plain run, saved ------------------------------------------------------------------------
out=$(measure --label after-start --out "$work/saved"); code=$?
is 'a run succeeds' "$code" 0
has 'the header says when' "$out" '^Taken:  [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC$'
has 'the header carries the label' "$out" '^Label:  after-start$'
has 'only names starting with lares- are measured, in order' "$out" '^Containers measured \(3\): lares-example-one lares-example-three lares-example-two$'
lacks 'other containers are left alone' "$out" 'other-thing'
has 'total and limit of a container' "$out" '^ +412\.3 MiB of a 1024\.0 MiB limit \(40\.26%\)'
has 'the launcher shows as its own process' "$out" '^ +4242 +1\.5 MiB  /bin/sh /usr/local/bin/launcher$'
has 'the server shows as its own process' "$out" '^ +4290 +380\.0 MiB  node --max-old-space-size=\[hidden\]$'
has 'an address in a command line is hidden' "$out" '^ +6100 +80\.0 MiB  /usr/local/bin/node /app/server\.js$'
lacks 'no secret from a command line or a setting is printed' "$out" 'made-up-secret'
lacks 'no setting is printed' "$out" 'API_TOKEN|PATH='
has 'anon from memory.stat' "$out" '^ +anon +398\.2 MiB'
has 'shmem from memory.stat' "$out" '^ +shmem +2\.0 MiB'
has 'kernel is the kernel line, not kernel_stack' "$out" '^ +kernel +6\.1 MiB'
has 'a line missing from memory.stat is skipped cleanly' "$out" '^ +kernel +not available'
has 'memory.peak when present' "$out" '^ +memory\.peak +530\.2 MiB'
has 'memory.peak when the file is missing' "$out" '^ +memory\.peak +not available'
has 'memory.stat when nothing can be read' "$out" '^ +anon, file, shmem, kernel, sock: not available'
has '/tmp as df prints it' "$out" '^ +tmpfs +7\.8G +2\.0M +7\.8G +1% /tmp$'
has '/tmp when df cannot be run' "$out" '^ +not available \(df could not be run'
has 'heap limit from the command line' "$out" '^ +768 MiB \(set with --max-old-space-size on the command line of the largest Node process, PID 4290\)$'
has 'heap limit when none is set' "$out" '^ +not available \(no --max-old-space-size is set'
has 'heap limit when there is no Node' "$out" '^ +not available \(no Node process'
has 'summary line, first container' "$out" '^  lares-example-one +412\.3 MiB +1024\.0 MiB +40\.26% +2 +380\.0 MiB +2\.0 MiB  2\.0M used \(1%\)$'
has 'summary line, second container' "$out" '^  lares-example-two +96\.0 MiB +1024\.0 MiB +9\.38% +1 +80\.0 MiB +0\.0 MiB  0 used \(0%\)$'
has 'summary line, container nothing can be run in' "$out" '^  lares-example-three +150\.0 MiB +2048\.0 MiB +7\.32% +3 +100\.0 MiB +-  -$'
has 'the total' "$out" '^  Total in use, 3 of 3 container\(s\): 658\.3 MiB$'

saved=$(ls "$work/saved")
has 'the saved file is named after the time and the label' "$saved" '^agent-memory-[0-9]{8}T[0-9]{6}Z-after-start\.txt$'
is 'exactly one file is saved' "$(printf '%s\n' "$saved" | wc -l | tr -d ' ')" 1
older="$work/saved/$saved"
# What was printed ends with an empty line and the "Saved as" line; the file holds everything before those.
is 'the saved file holds what was printed' "$(cat "$older")" "$(printf '%s\n' "$out" | sed '$d' | sed '$d')"
has 'the run says where it saved' "$out" "^Saved as $work/saved/agent-memory-"

# --- compare with the saved file ---------------------------------------------------------------
out=$(FAKE_DOCKER_SCENARIO=later measure --label after-chat --compare "$older"); code=$?
is 'a compare run succeeds' "$code" 0
has 'compare names the older measurement' "$out" '^  older: taken .* UTC, label after-start \('
has 'compare names this measurement' "$out" '^  now:   taken .* UTC, label after-chat$'
has 'compare: total grew' "$out" '^    total +412\.3 MiB -> +498\.0 MiB   \+85\.7 MiB$'
has 'compare: the server grew' "$out" '^    node --max-old-space-size=\[hidden\] +380\.0 MiB -> +459\.0 MiB   \+79\.0 MiB$'
has 'compare: the launcher did not change' "$out" '^    /bin/sh /usr/local/bin/launcher +1\.5 MiB -> +1\.5 MiB   \+0\.0 MiB$'
has 'compare: a process that was not there before' "$out" '^    node /app/worker\.js +- -> +20\.0 MiB   new since then$'
has 'compare: total shrank' "$out" '^    total +96\.0 MiB -> +90\.0 MiB   -6\.0 MiB$'
has 'compare: same-named processes are added up' "$out" '^    postgres: writer +8\.0 MiB -> +8\.0 MiB   \+0\.0 MiB \(x2\)$'
has 'compare: all containers together' "$out" '^  All 3 container\(s\) in both measurements +658\.3 MiB -> +738\.0 MiB   \+79\.7 MiB$'
has 'heap limit from the NODE_OPTIONS setting' "$out" '^ +512 MiB \(set with --max-old-space-size in the container.s NODE_OPTIONS setting\)$'
lacks 'compare prints no secret either' "$out" 'made-up-secret|API_TOKEN'

out=$(FAKE_DOCKER_SCENARIO=later measure --compare "$older" lares-example-two); code=$?
is 'a compare run for one named container succeeds' "$code" 0
has 'compare: a container measured before but not now is named' "$out" '^  In the older file but not measured now: lares-example-one lares-example-three$'

out=$(refused --compare "$script"); code=$?
is 'comparing with a file that is no measurement stops' "$code" 1
has 'and says so' "$out" 'is not a measurement saved by this script'

# --- names as arguments ------------------------------------------------------------------------
out=$(measure lares-example-two lares-example-gone); code=$?
is 'a run for named containers succeeds' "$code" 0
has 'only the named container is measured' "$out" '^Containers measured \(1\): lares-example-two$'
has 'a named container that is not running is reported' "$out" '^Named but not running, so not measured: lares-example-gone$'
has 'the total covers only what was measured' "$out" '^  Total in use, 1 of 1 container\(s\): 96\.0 MiB$'
has 'no label is shown as none' "$out" '^Label:  \(none\)$'

# --- nothing to measure ------------------------------------------------------------------------
out=$(FAKE_DOCKER_SCENARIO=none refused); code=$?
is 'no matching container: stops' "$code" 1
has 'no matching container: one clear sentence' "$out" '^No running container has a name that starts with "lares-"\. Nothing was measured\.$'

out=$(refused lares-example-gone); code=$?
is 'named containers all stopped: stops' "$code" 1
has 'named containers all stopped: one clear sentence' "$out" '^None of the containers you named is running: lares-example-gone\. Nothing was measured\.$'

out=$(LARES_MEASURE_DOCKER="$work/no-such-docker" sh "$script" 2>&1); code=$?
is 'no Docker: stops' "$code" 1
has 'no Docker: one clear sentence' "$out" '^Docker is not available here: .* Nothing was measured\.$'

out=$(FAKE_DOCKER_SCENARIO=down refused); code=$?
is 'Docker not answering: stops' "$code" 1
has 'Docker not answering: one clear sentence' "$out" '^Docker is installed but did not answer\..* Nothing was measured\.$'

out=$(refused --frobnicate); code=$?
is 'an unknown option is refused' "$code" 2
out=$(refused 'lares-example-one;reboot'); code=$?
is 'something that is not a container name is refused' "$code" 2

printf '\n%s checks passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
