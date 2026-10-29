import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ImportInspectionRefused,
  buildInspection,
  inspectExportArchive,
  verifySourceLedger,
} from "../bin/import-preview.js";
import { IMPORT_CATEGORIES } from "@lares/agent-kit/authority-contract";

const roots: string[] = [];
function fixtureArchive(options: { badChecksum?: boolean; nestedName?: string; source?: string; oversizedManifest?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "import-preview-"));
  roots.push(root);
  const archive = join(root, "export.tar");
  const script = String.raw`
import hashlib, io, json, sys, tarfile
root, archive, bad, nested_name, source, oversized = sys.argv[1:]
files = {
  "globals.sql": b"-- fixture globals without password material\n",
  "lares_state.dump": b"synthetic custom database dump",
  "postgres.dump": b"synthetic postgres dump",
}
nested = io.BytesIO()
with tarfile.open(fileobj=nested, mode="w") as tf:
    directory = tarfile.TarInfo("agents/example/")
    directory.type = tarfile.DIRTYPE
    tf.addfile(directory)
    content = b"synthetic agent definition\n"
    info = tarfile.TarInfo(nested_name)
    info.size = len(content)
    tf.addfile(info, io.BytesIO(content))
files["agents.tar"] = nested.getvalue()
manifest = {"engineVersion": source, "date": "x" * (1024 * 1024 + 1) if oversized == "yes" else "2026-10-21T00:00:00Z", "files": []}
for name, data in files.items():
    manifest["files"].append({"name": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
if bad == "yes": manifest["files"][0]["sha256"] = "0" * 64
with tarfile.open(archive, mode="w") as tf:
    payloads = {**files, "manifest.json": json.dumps(manifest).encode()}
    for name, data in payloads.items():
        info = tarfile.TarInfo("./" + name)
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
`;
  execFileSync("python3", ["-c", script, root, archive, options.badChecksum ? "yes" : "no", options.nestedName ?? "agents/example/agent.json", options.source ?? "2026-10-21-rc.12", options.oversizedManifest ? "yes" : "no"]);
  return archive;
}

function ledgerCopy(extra?: string): string {
  const checksums = [
    "a2a50ac42a53b25ba28faf41e8b8970354292f131e0e673cb7cc2a0001fa725a",
    "8d1abbab5d997af30f185454aac3a46407bc6d96fde2f555065522fd0df7b58a",
    "a7a43c6ae74466e398935afac6ec379f39ee2ccdf7d4ca8e78b2cdc482949cfa",
    "56c5e04433aa350c9ed7bbed4d7aa0eb533d910f921cba2fe526183ac262dd0b",
    "e1ecab54f9c18c63b057f7970c70fa835ebeb0e09381b6295c4f64a20a91be66",
    "2de295f5c742a004addeb28579d579865bb7832a5d5287be742d0e2e7944827b",
  ];
  const names = ["001_baseline.sql", "002_standing_facts.sql", "003_outside_tool_seen.sql", "004_web_inbox.sql", "005_model_steps.sql", "006_approval_session.sql"];
  return [
    "COPY public.schema_migrations (filename, number, checksum, applied_at, how, took_ms, seq) FROM stdin;",
    ...names.map((name, i) => `${name}\t${i + 1}\t${checksums[i]}\t2026-10-21 00:00:00+00\tapplied\t0\t${i + 1}`),
    ...(extra ? [extra] : []),
    "\\.",
  ].join("\n");
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function installedHarness(mode: "success" | "overflow" | "timeout" | "inspect" = "success") {
  const root = mkdtempSync(join(tmpdir(), "lares-cli-harness-"));
  roots.push(root);
  const prefix = join(root, "prefix");
  const release = join(prefix, "opt", "lares", "releases", "fixture");
  const current = join(prefix, "opt", "lares", "current");
  const ops = join(release, "services", "box", "ops");
  const bin = join(root, "bin");
  const privateTmp = join(root, "tmp");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "ops");
  mkdirSync(ops, { recursive: true });
  mkdirSync(bin);
  mkdirSync(privateTmp);
  symlinkSync(release, current);
  copyFileSync(join(repo, "lares"), join(ops, "lares"));
  copyFileSync(join(repo, "engine-run.sh"), join(ops, "engine-run.sh"));
  writeFileSync(join(release, "release.json"), JSON.stringify({ images: { "lares-keeper": `example.invalid/keeper@sha256:${"a".repeat(64)}` } }));
  const idPath = join(bin, "id");
  writeFileSync(idPath, "#!/bin/sh\n[ \"$1\" = -u ] && { echo 0; exit 0; }\nexit 1\n");
  chmodSync(idPath, 0o755);
  const dockerPath = join(bin, "docker");
  writeFileSync(dockerPath, `#!/bin/bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *--pull=never*)
    case "$DOCKER_MODE" in
      timeout) exit 124 ;;
      overflow)
        for arg in "$@"; do case "$arg" in *:/output:rw) target="${'${arg%:/output:rw}'}"; printf 'RAW-LEDGER-SECRET%s' "$(python3 -c 'print("x" * 140000)')" > "$target/schema-migrations.copy";; esac; done
        ;;
      success|inspect)
        for arg in "$@"; do case "$arg" in *:/output:rw) target="${'${arg%:/output:rw}'}"; printf '%s' "$LEDGER_PAYLOAD" > "$target/schema-migrations.copy";; esac; done
        ;;
    esac
    ;;
esac
if [ "$DOCKER_MODE" = inspect ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = /app/services/box/ops/unpack-engine.sh ]; then
      shift
      exec bash "$PREVIEW_UNPACK" "$@"
    fi
    if [ "$1" = /app/services/box/bin/import-preview.ts ]; then
      shift
      TMPDIR="$PREVIEW_RUNTIME_TMP" exec "$PREVIEW_NODE" --import tsx/esm "$PREVIEW_SCRIPT" "$@"
    fi
    shift
  done
fi
exit 0
`);
  chmodSync(dockerPath, 0o755);
  const timeoutPath = join(bin, "timeout");
  writeFileSync(timeoutPath, "#!/bin/bash\n[ \"$1\" = --signal=INT ] || exit 125\nshift\n[ \"$1\" = --kill-after=10 ] || exit 125\nshift\n[ \"$1\" = 120 ] || exit 125\nshift\nexec \"$@\"\n");
  chmodSync(timeoutPath, 0o755);
  return { root, prefix, bin, privateTmp, cli: join(ops, "lares"), dockerLog: join(root, "docker.log") };
}

describe("PR1a export archive inspection", () => {
  it("verifies a real export-shaped archive and reports every category as uninspected", () => {
    const archive = inspectExportArchive(fixtureArchive());
    expect(archive).toMatchObject({ verifiedFiles: 4, kinds: { databaseDumps: 2, dataArchives: 1, vaultBundles: 0, otherFiles: 1 }, nestedRegularFiles: 1 });
    verifySourceLedger(ledgerCopy());
    const result = buildInspection(archive);
    expect(result).toMatchObject({ format: "lares.import-inspection", status: "inspection-only", importReadiness: "blocked" });
    expect(result.categories.map((entry) => entry.category)).toEqual(IMPORT_CATEGORIES);
    expect(result.categories.every((entry) => entry.status === "not-inventoried" && entry.count === null && entry.checksum === null)).toBe(true);
    expect(result.format).not.toBe("lares.import-manifest");
  });

  it("refuses a checksum mismatch without printing archived content", () => {
    expect(() => inspectExportArchive(fixtureArchive({ badChecksum: true }))).toThrowError(
      new ImportInspectionRefused("checksum_mismatch"),
    );
  });

  it("bounds manifest reads using the tar header and refuses oversized manifests", () => {
    expect(() => inspectExportArchive(fixtureArchive({ oversizedManifest: true }))).toThrowError(
      new ImportInspectionRefused("invalid_manifest"),
    );
  });

  it("refuses traversal and secret-bearing nested ordinary archives", () => {
    expect(() => inspectExportArchive(fixtureArchive({ nestedName: "../escape.txt" }))).toThrowError(
      new ImportInspectionRefused("unsafe_path"),
    );
    expect(() => inspectExportArchive(fixtureArchive({ nestedName: "agents/example/.env" }))).toThrowError(
      new ImportInspectionRefused("secret_path"),
    );
  });

  it("refuses an unknown exporter version or a changed/extra migration ledger", () => {
    expect(() => buildInspection(inspectExportArchive(fixtureArchive({ source: "unknown" })))).toThrowError(
      new ImportInspectionRefused("unsupported_source_release"),
    );
    expect(() => verifySourceLedger(ledgerCopy("unexpected.sql\t7\t" + "a".repeat(64) + "\t2026\tadopted\t0\t7"))).toThrowError(
      new ImportInspectionRefused("source_schema_mismatch"),
    );
  });

  it("runs the CLI entrypoint with four arguments and redacts a rejected ledger", () => {
    const archive = fixtureArchive();
    const root = dirname(archive);
    const ledgerPath = join(root, "schema-migrations.copy");
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "import-preview.ts");
    writeFileSync(ledgerPath, ledgerCopy());
    const accepted = spawnSync(process.execPath, ["--import", "tsx/esm", script, "--archive", archive, "--ledger-copy", ledgerPath], { encoding: "utf8" });
    expect(accepted.status, accepted.stderr).toBe(0);
    const result = JSON.parse(accepted.stdout);
    expect(result).toMatchObject({ format: "lares.import-inspection", status: "inspection-only", importReadiness: "blocked" });

    writeFileSync(ledgerPath, "SECRET-LEDGER-SENTINEL");
    const refused = spawnSync(process.execPath, ["--import", "tsx/esm", script, "--archive", archive, "--ledger-copy", ledgerPath], { encoding: "utf8" });
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain("source_schema_mismatch");
    expect(refused.stderr).not.toContain("SECRET-LEDGER-SENTINEL");
  });
});

describe("installed import-preview command boundary", () => {
  it("uses the pinned local helper image and read-only archive mounts without DB credentials", () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "lares");
    const cli = readFileSync(path, "utf8");
    expect(cli).toContain("lares import-preview <archive.tar>");
    expect(cli).toContain("--pull=never --network none --read-only --tmpfs /tmp");
    expect(cli).toContain("docker.io/pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b");
    expect(cli).toContain("./lares_state.dump");
    expect(cli).toContain("-v \"$archive:/input.tar:ro\"");
    expect(cli).toContain("pg_restore --data-only --table=schema_migrations -f -");
    expect(cli).toContain("timeout --signal=INT --kill-after=10 120 docker run");
    expect(cli).toContain("ulimit -f 256");
    expect(cli).toContain("bin/import-preview.ts --check-archive \"$archive\"");
    expect(cli).toContain("engine_run --network-none --ro \"$archive\" --ro \"$ledger_file\"");
    const previewCommand = cli.split("cmd_import_preview() {")[1]?.split("cmd_owner_bootstrap()")[0] ?? "";
    expect(previewCommand).not.toMatch(/DATABASE_PASSWORD|LARES_OPERATOR_PASSWORD|docker\.sock/);
    expect(previewCommand).not.toMatch(/pg_restore[^\n]*\s-d\s/);
  });

  it("keeps engine-run networking unchanged unless a caller explicitly disables it", () => {
    const script = String.raw`
docker() { printf 'CALL'; printf '|%s' "$@"; printf '\n'; }
. "$1"
ENGINE_IMAGE='example.invalid/keeper@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
engine_run --network-none bin/check.ts
engine_run bin/check.ts
`;
    const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "engine-run.sh");
    const output = execFileSync("bash", ["-c", script, "bash", runner], { encoding: "utf8" });
    expect(output).toContain("--network|none");
    expect(output).toContain("--network|host");
  });

  it("resolves the workflow's unpacked image and executes real archive and ledger inspection offline", () => {
    const harness = installedHarness("inspect");
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const workflow = readFileSync(join(repo, ".github/workflows/keeper-runtime-images.yml"), "utf8");
    const proofStep = workflow.split("- name: Prove packaged import preview refuses to claim an inventory")[1]!.split("- uses:")[0]!;
    const imageArgument = proofStep.match(/"(lares-keeper[^"\n]+)" "\$GITHUB_SHA"/)![1]!;
    const image = imageArgument.replace("${{ steps.keeper-image.outputs.digest }}", `sha256:${"a".repeat(64)}`);
    const archive = join(harness.root, "probe-export.tar");
    const dump = join(harness.root, "synthetic.dump");
    writeFileSync(dump, "synthetic dump: the offline test never invokes PostgreSQL");
    execFileSync("python3", ["-B", "-c", String.raw`
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("proof", sys.argv[1])
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
proof.archive_from_dump(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
`, join(repo, "services/keeper/tests/import-preview-image.probe.py"), dump, archive]);
    const runtimeTmp = join(harness.root, "runtime-tmp");
    mkdirSync(runtimeTmp);
    const env: NodeJS.ProcessEnv = {
      ...process.env, LARES_PREFIX: harness.prefix, TMPDIR: harness.privateTmp,
      PATH: `${harness.bin}:${process.env.PATH}`, DOCKER_LOG: harness.dockerLog,
      DOCKER_MODE: "inspect", LEDGER_PAYLOAD: ledgerCopy(), PREVIEW_RUNTIME_TMP: runtimeTmp, PREVIEW_NODE: process.execPath,
      PREVIEW_SCRIPT: join(repo, "services/box/bin/import-preview.ts"),
    };
    const guardBin = execFileSync("python3", ["-B", "-c", String.raw`
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("proof", sys.argv[1])
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
guard, _ = proof.install_docker_guard(pathlib.Path(sys.argv[2]), sys.argv[3])
print(guard)
`, join(repo, "services/keeper/tests/import-preview-image.probe.py"), harness.root, image], { env, encoding: "utf8" }).trim();
    env.PATH = `${guardBin}:${env.PATH}`;
    env.LARES_PROBE_REAL_DOCKER = join(harness.bin, "docker");
    env.LARES_PROBE_KEEPER_REF = image;
    env.LARES_PROBE_EVENTS = join(harness.root, "docker-boundary-events");
    env.PREVIEW_UNPACK = join(repo, "services/box/ops/unpack-engine.sh");
    env.APP_ROOT = repo;
    env.OUT_ROOT = join(harness.prefix, "opt/lares/releases");
    delete env.LARES_ENGINE_IMAGE;
    delete env.BOX_DIR;
    const unpacked = spawnSync(join(guardBin, "docker"), [
      "run", "--rm", "--network", "none", "--user", "0:0", "--env", "OUT_ROOT=/out",
      "--mount", `type=bind,src=${env.OUT_ROOT},dst=/out`, "--entrypoint", "bash",
      image, "/app/services/box/ops/unpack-engine.sh", "fixture", image,
    ], { env, encoding: "utf8" });
    expect(unpacked.status, unpacked.stderr).toBe(0);
    const result = spawnSync("bash", [harness.cli, "import-preview", archive], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(harness.prefix, "opt/lares/current/services/box/engine-image"), "utf8").trim()).toBe(image);
    const inspection = JSON.parse(result.stdout);
    expect(inspection).toMatchObject({ status: "inspection-only", importReadiness: "blocked", archive: { verifiedFiles: 4, nestedRegularFileCount: 1 } });
    expect(inspection.categories.map((entry: { category: string }) => entry.category)).toEqual(IMPORT_CATEGORIES);
    expect(inspection.categories.every((entry: { status: string; count: unknown; checksum: unknown }) => entry.status === "not-inventoried" && entry.count === null && entry.checksum === null)).toBe(true);
    expect(readFileSync(harness.dockerLog, "utf8").match(/--network none/g)).toHaveLength(4);
    expect(readFileSync(env.LARES_PROBE_EVENTS!, "utf8").trim().split("\n")).toEqual([
      "keeper-preview-safe", "helper-safe", "keeper-preview-safe",
    ]);
    expect(readdirSync(harness.privateTmp)).toEqual([]);
  });

  it("runs the actual installed command without image overrides using only a Docker stub", () => {
    const harness = installedHarness();
    const archive = fixtureArchive();
    const env: NodeJS.ProcessEnv = { ...process.env, LARES_PREFIX: harness.prefix, TMPDIR: harness.privateTmp, PATH: `${harness.bin}:${process.env.PATH}`, DOCKER_LOG: harness.dockerLog, DOCKER_MODE: "success", LEDGER_PAYLOAD: ledgerCopy() };
    delete env.LARES_ENGINE_IMAGE;
    delete env.BOX_DIR;
    const result = spawnSync("bash", [harness.cli, "import-preview", archive], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(harness.dockerLog, "utf8").match(/--network none/g)).toHaveLength(3);
    expect(readFileSync(harness.dockerLog, "utf8")).toContain("example.invalid/keeper@sha256:");
    expect(readdirSync(harness.privateTmp)).toEqual([]);
  });

  it.each(["overflow", "timeout"] as const)("cleans private output and redacts Docker diagnostics on %s", (mode) => {
    const harness = installedHarness(mode);
    const archive = fixtureArchive();
    const env: NodeJS.ProcessEnv = { ...process.env, LARES_PREFIX: harness.prefix, TMPDIR: harness.privateTmp, PATH: `${harness.bin}:${process.env.PATH}`, DOCKER_LOG: harness.dockerLog, DOCKER_MODE: mode, LEDGER_PAYLOAD: ledgerCopy() };
    delete env.LARES_ENGINE_IMAGE;
    delete env.BOX_DIR;
    const result = spawnSync("bash", [harness.cli, "import-preview", archive], { env, encoding: "utf8" });
    expect(result.status).toBe(64);
    expect(result.stderr).not.toContain("RAW-LEDGER-SECRET");
    expect(result.stderr).not.toContain("x".repeat(100));
    expect(readdirSync(harness.privateTmp)).toEqual([]);
  });
});
