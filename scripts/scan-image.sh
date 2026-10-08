#!/usr/bin/env bash
# CI-only scan of an already loaded final amd64 image. Reports do not clear a release.
set -euo pipefail
image=${1:?image required}
output=${2:?report directory required}
: "${RUNNER_TEMP:?Run image scans in CI}"
: "${GITHUB_SHA:?Source commit required}"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
mkdir -p "$output"
version=0.75.0
checksum=c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f
scanner="$RUNNER_TEMP/lares-trivy-$version"
if [[ ! -x "$scanner/trivy" ]]; then
  mkdir -p "$scanner"
  curl --fail --location --retry 3 \
    "https://github.com/aquasecurity/trivy/releases/download/v$version/trivy_${version}_Linux-64bit.tar.gz" \
    --output "$scanner/trivy.tar.gz"
  echo "$checksum  $scanner/trivy.tar.gz" | sha256sum --check --strict
  tar -xzf "$scanner/trivy.tar.gz" -C "$scanner" trivy
fi
# Retain image ID/layers/platform without serializing environment or secrets.
docker image inspect "$image" --format '{{json .}}' | python3 -c '
import json, os, sys, datetime
image=json.load(sys.stdin)
assert image["Os"] == "linux" and image["Architecture"] == "amd64"
json.dump({"source":os.environ["GITHUB_SHA"], "scanned_at":datetime.datetime.now(datetime.timezone.utc).isoformat(), "image_id":image["Id"], "os":image["Os"], "architecture":image["Architecture"], "layers":image["RootFS"]["Layers"]},sys.stdout,indent=2)
' > "$output/image.json"
# No secret scan, ignore list or severity suppression. Preserve every match for review.
"$scanner/trivy" image --image-src docker --scanners vuln --list-all-pkgs \
  --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --ignorefile /dev/null --timeout 10m --format json --output "$output/scan.json" "$image"
"$scanner/trivy" version --format json > "$output/scanner.json"
python3 - "$output/scan.json" <<'PY'
import json, sys, collections
report=json.load(open(sys.argv[1]))
counts=collections.Counter(v['Severity'] for r in report.get('Results',[]) for v in r.get('Vulnerabilities',[]))
print('Final image vulnerability occurrences:', dict(counts))
print('These are scanner matches, not a release clearance; review each high/critical finding.')
PY
