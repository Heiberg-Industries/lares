"""Verify that both role images contain the exact, integrity-checked public docs corpus."""
import json
import pathlib
import subprocess
import sys
import tempfile

if len(sys.argv) != 6 or sys.argv[1] not in ("chief-of-staff", "creative"):
    raise SystemExit("usage: public-docs-image.probe.py <chief-of-staff|creative> <runtime-image> <source-commit> <release> <proof.json>")

probe = r'''import { readBakedPublicDoc, publicDocsIndex } from "/app/packages/agent-kit/src/public-docs-runtime.ts";
import { PUBLIC_DOC_IDS, PUBLIC_DOCS, verifyPublicCorpus } from "/app/packages/agent-kit/src/public-docs.ts";
const pages = PUBLIC_DOC_IDS.map((id) => readBakedPublicDoc(id));
if (pages.length !== PUBLIC_DOCS.length || pages.some((page) => !page.markdown || page.id === "")) throw new Error("known page read failed");
if (!pages.every((page) => page.release === pages[0].release && page.sourceCommit === pages[0].sourceCommit && page.corpusSha256 === pages[0].corpusSha256)) throw new Error("page identity drifted");
if (publicDocsIndex().length > 4000 || !PUBLIC_DOC_IDS.every((id) => publicDocsIndex().includes(id))) throw new Error("public index is not bounded");
let unknownRefused = false;
try { readBakedPublicDoc("../../etc/passwd"); } catch { unknownRefused = true; }
if (!unknownRefused) throw new Error("unknown page ID was accepted");
let wrongHashRefused = false;
try { verifyPublicCorpus("/app/public-docs/snapshot", "f".repeat(64)); } catch { wrongHashRefused = true; }
if (!wrongHashRefused) throw new Error("wrong expected corpus hash was accepted");
console.log(JSON.stringify({release: pages[0].release, sourceCommit: pages[0].sourceCommit, corpusSha256: pages[0].corpusSha256, pages: pages.length}));
'''

with tempfile.TemporaryDirectory(prefix="lares-public-docs-image-probe-") as temp:
    script = pathlib.Path(temp) / "public-docs-image-probe.mts"
    script.write_text(probe)
    role, image, expected_source, expected_release, proof_path = sys.argv[1:]
    executable = f"/app/services/{role}/node_modules/.bin/tsx"
    result_text = subprocess.check_output([
        "docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none",
        "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=16m", "--user", "10001:10001", "--mount",
        f"type=bind,src={script},dst=/run/public-docs-image-probe.mts,readonly",
        "--entrypoint", executable, image, "/run/public-docs-image-probe.mts",
    ], text=True, stderr=subprocess.STDOUT, timeout=60).strip()
    result = json.loads(result_text)
    if result.get("sourceCommit") != expected_source or result.get("release") != expected_release:
        raise RuntimeError("Baked public docs identity does not match the checked-out source and requested release")
    image_id = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image], text=True, timeout=30).strip()
    proof = {"role": role, "runtimeImageId": image_id, **result}
    pathlib.Path(proof_path).write_text(json.dumps(proof, sort_keys=True, separators=(",", ":")) + "\n")
    print(f"{role}: {json.dumps(proof, sort_keys=True)}")
