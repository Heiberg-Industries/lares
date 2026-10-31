"""CI proof for the packaged, blocked import-preview command using synthetic data only."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid


PINNED_DB_IMAGE = "docker.io/pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b"
CATEGORIES = [
    "members", "identities", "grants", "agents", "accounts", "resource-bindings",
    "conversations", "vault", "facts", "taste", "archives", "jobs", "approvals",
    "actions", "budgets", "settings", "safety", "sync", "suppression", "contacts",
    "source-links", "domain-records",
]
STAGES = {"fixture", "unpack", "installed-command", "refusal", "cleanup"}
PHASES = {
    "fixture-setup", "helper-pull", "fixture-db-start", "fixture-db-readiness",
    "fixture-ledger-seed", "fixture-custom-dump", "fixture-db-remove", "image-unpack",
    "installed-preview", "unsafe-archive-refusal", "cleanup",
}
FAILURES = {"command-failed", "command-timeout", "command-execution-failed", "assertion-failed", "unexpected-output", "cleanup-failed"}
DIAGNOSTIC_CATEGORIES = {
    "command-nonzero", "command-timeout", "command-execution-failed", "unsupported-source-release",
    "source-schema-mismatch", "source-schema-inventory-mismatch", "archive-refused", "helper-read-failed", "inspection-failed",
    "member-copy-refused",
    "output-invalid", "output-assertion-failed", "unknown-output",
}
INSPECTION_CHECKS = {
    "toc_too_large", "toc_encoding_invalid", "toc_archive_header_missing", "toc_selection_header_missing",
    "toc_entry_format_invalid", "toc_tokenization_failed", "toc_entry_tokens_empty", "toc_security_wrapper_invalid",
    "toc_comment_acl_wrapper_invalid", "toc_wrapped_object_missing", "toc_wrapped_schema_invalid",
    "toc_schema_declaration_invalid", "toc_default_acl_invalid", "toc_namespace_object_incomplete",
    "toc_global_object_invalid", "toc_object_type_unsupported", "toc_schema_identifier_invalid",
    "toc_explicit_schema_duplicate", "toc_entries_missing", "parser_internal_failure",
    "toc_read_failed", "parser_unavailable", "parser_launch_failed", "parser_output_limit", "parser_signaled",
    "parser_exit_unclassified", "parser_output_json_invalid", "parser_output_shape_invalid",
    "parser_schema_value_invalid", "parser_schema_order_invalid", "schema_list_mismatch",
    "member_copy_envelope_invalid", "unsupported_copy_format", "malformed_copy_data",
    "copy_data_too_large", "copy_row_too_large", "copy_row_limit_exceeded",
}
MEMBER_COPY_REFUSALS = {
    "member_copy_envelope_invalid", "unsupported_copy_format", "malformed_copy_data",
    "copy_data_too_large", "copy_row_too_large", "copy_row_limit_exceeded",
}
INSPECTION_MARKER = b"lares import-preview inspectionCheck="
MEMBER_REFUSAL_MARKER = b"lares import-preview: refused ("
KNOWN_ERROR_MARKERS = {
    b"lares import-preview: refused (unsupported_source_release); no import data was written.": "unsupported-source-release",
    b"lares import-preview: refused (source_schema_mismatch); no import data was written.": "source-schema-mismatch",
    b"lares import-preview: refused (source_schema_inventory_mismatch); no import data was written.": "source-schema-inventory-mismatch",
    b"lares import-preview: refused (unreadable_archive); no import data was written.": "archive-refused",
    b"lares import-preview: refused (member_copy_envelope_invalid); no import data was written.": "member-copy-refused",
    b"lares import-preview: refused (unsupported_copy_format); no import data was written.": "member-copy-refused",
    b"lares import-preview: refused (malformed_copy_data); no import data was written.": "member-copy-refused",
    b"lares import-preview: refused (copy_data_too_large); no import data was written.": "member-copy-refused",
    b"lares import-preview: refused (copy_row_too_large); no import data was written.": "member-copy-refused",
    b"lares import-preview: refused (copy_row_limit_exceeded); no import data was written.": "member-copy-refused",
    b"the source schema could not be read by the pinned local helper image; no database was contacted.": "helper-read-failed",
    b"this release has no pinned Keeper image for the inspection command.": "inspection-failed",
}
CHECKS = {
    "syntheticCustomDump": False,
    "actualInstalledCommand": False,
    "remainingCategoriesRemainUninventoried": False,
    "ownedRecordGroupsRedacted": False,
    "unsafeArchiveRefusedAndRedacted": False,
    "helperRanOfflineWithReadOnlyInput": False,
    "scratchRemoved": False,
}


class ProbeFailure(Exception):
    def __init__(self, kind: str = "assertion-failed") -> None:
        self.kind = kind if kind in FAILURES else "assertion-failed"


def fresh_proof() -> dict[str, object]:
    return {
        "format": 1,
        "status": "running",
        "stage": "fixture",
        "phase": "fixture-setup",
        "failureKind": None,
        "commandExitCode": None,
        "failureCategory": None,
        "inspectionCheck": None,
        "checks": dict(CHECKS),
        "unmappedCategoryCount": 18,
        "cleanupOkay": False,
    }


def proof_is_safe(proof: object) -> bool:
    if not isinstance(proof, dict) or set(proof) != {
        "format", "status", "stage", "phase", "failureKind", "commandExitCode", "failureCategory", "inspectionCheck", "checks",
        "unmappedCategoryCount", "cleanupOkay"
    }:
        return False
    if (proof["format"] != 1 or not isinstance(proof["status"], str)
            or proof["status"] not in {"running", "passed", "failed"}):
        return False
    if (not isinstance(proof["stage"], str) or proof["stage"] not in STAGES
            or not isinstance(proof["phase"], str) or proof["phase"] not in PHASES
            or (proof["failureKind"] is not None and not isinstance(proof["failureKind"], str))
            or proof["failureKind"] not in FAILURES | {None}):
        return False
    exit_code = proof["commandExitCode"]
    if exit_code is not None and (type(exit_code) is not int or not 0 <= exit_code <= 255):
        return False
    category = proof["failureCategory"]
    if category is not None and (not isinstance(category, str) or category not in DIAGNOSTIC_CATEGORIES):
        return False
    inspection_check = proof["inspectionCheck"]
    if inspection_check is not None and (not isinstance(inspection_check, str) or inspection_check not in INSPECTION_CHECKS):
        return False
    if proof["unmappedCategoryCount"] != len(CATEGORIES) - 4:
        return False
    checks = proof["checks"]
    return (isinstance(checks, dict) and set(checks) == set(CHECKS)
            and all(type(value) is bool for value in checks.values())
            and type(proof["cleanupOkay"]) is bool)


def atomic_proof(path: pathlib.Path, proof: dict[str, object]) -> None:
    if not proof_is_safe(proof):
        raise ProbeFailure("unexpected-output")
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(proof, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temp, path)


def set_phase(proof: dict[str, object], path: pathlib.Path, phase: str) -> None:
    if phase not in PHASES:
        raise ProbeFailure("unexpected-output")
    proof["phase"] = phase
    proof["commandExitCode"] = None
    proof["failureCategory"] = None
    proof["inspectionCheck"] = None
    atomic_proof(path, proof)


def run(argv: list[str], *, input_text: str | None = None, timeout: int = 120,
        stdout: int | None = subprocess.PIPE, env: dict[str, str] | None = None,
        proof: dict[str, object] | None = None, proof_path: pathlib.Path | None = None,
        phase: str | None = None) -> subprocess.CompletedProcess[bytes]:
    if phase is not None:
        if proof is None or proof_path is None:
            raise ProbeFailure("unexpected-output")
        set_phase(proof, proof_path, phase)
    try:
        result = subprocess.run(argv, input=input_text.encode() if input_text is not None else None,
                                stdout=stdout, stderr=subprocess.PIPE, timeout=timeout, check=False, env=env)
    except subprocess.TimeoutExpired:
        if proof is not None and proof_path is not None:
            proof["failureKind"] = "command-timeout"
            proof["failureCategory"] = "command-timeout"
            atomic_proof(proof_path, proof)
        raise ProbeFailure("command-timeout") from None
    except OSError:
        if proof is not None and proof_path is not None:
            proof["failureKind"] = "command-execution-failed"
            proof["failureCategory"] = "command-execution-failed"
            atomic_proof(proof_path, proof)
        raise ProbeFailure("command-execution-failed") from None
    if result.returncode != 0:
        if proof is not None and proof_path is not None:
            proof["commandExitCode"] = max(0, min(255, result.returncode))
            proof["failureKind"] = "command-failed"
            proof["failureCategory"] = "command-nonzero"
            atomic_proof(proof_path, proof)
        raise ProbeFailure("command-failed")
    return result


def classify_installed_failure(stdout: bytes, stderr: bytes) -> str:
    combined = stdout + b"\n" + stderr
    for marker, category in KNOWN_ERROR_MARKERS.items():
        if marker in combined:
            return category
    return "unknown-output"


def inspection_check_from_stderr(stderr: bytes) -> str | None:
    lines = stderr.splitlines()
    toc_lines = [line for line in lines if line.startswith(INSPECTION_MARKER)]
    if toc_lines:
        if len(toc_lines) != 1:
            return None
        prefix, separator, value = toc_lines[0].partition(b"=")
        if prefix != INSPECTION_MARKER.removesuffix(b"=") or not separator:
            return None
        try:
            check = value.decode("ascii")
        except UnicodeDecodeError:
            return None
        return check if check in INSPECTION_CHECKS else None

    refusal_lines = [line for line in lines if MEMBER_REFUSAL_MARKER in line]
    if len(refusal_lines) != 1:
        return None
    match = re.fullmatch(rb"lares import-preview: refused \(([^()\r\n]+)\); no import data was written\.", refusal_lines[0])
    if match is None:
        return None
    try:
        reason = match.group(1).decode("ascii")
    except UnicodeDecodeError:
        return None
    return reason if reason in MEMBER_COPY_REFUSALS else None


def run_installed(argv: list[str], *, env: dict[str, str], timeout: int,
                  proof: dict[str, object], proof_path: pathlib.Path) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        proof["failureKind"] = "command-timeout"
        proof["failureCategory"] = "command-timeout"
        atomic_proof(proof_path, proof)
        raise ProbeFailure("command-timeout") from None
    except OSError:
        proof["failureKind"] = "command-execution-failed"
        proof["failureCategory"] = "command-execution-failed"
        atomic_proof(proof_path, proof)
        raise ProbeFailure("command-execution-failed") from None
    if result.returncode != 0:
        proof["commandExitCode"] = max(0, min(255, result.returncode))
        proof["failureKind"] = "command-failed"
        proof["failureCategory"] = classify_installed_failure(result.stdout or b"", result.stderr or b"")
        proof["inspectionCheck"] = inspection_check_from_stderr(result.stderr or b"")
        atomic_proof(proof_path, proof)
        raise ProbeFailure("command-failed")
    return result


def self_test() -> None:
    proof = fresh_proof()
    assert proof_is_safe(proof)
    assert proof["unmappedCategoryCount"] == 18
    assert classify_installed_failure(
        b"", b"lares import-preview: refused (member_copy_envelope_invalid); no import data was written."
    ) == "member-copy-refused"
    assert classify_installed_failure(
        b"", b"lares import-preview: refused (member_copy_envelope_invalid extra); token=SECRET_SENTINEL"
    ) == "unknown-output"
    for reason in sorted(MEMBER_COPY_REFUSALS):
        refusal = f"lares import-preview: refused ({reason}); no import data was written.".encode("ascii")
        assert inspection_check_from_stderr(refusal) == reason
        assert proof_is_safe({**proof, "inspectionCheck": reason})
        assert inspection_check_from_stderr(refusal + b"\n" + refusal) is None
        assert inspection_check_from_stderr(b"SECRET_SENTINEL" + refusal) is None
        assert inspection_check_from_stderr(refusal + b" SECRET_SENTINEL") is None
    assert inspection_check_from_stderr(
        b"lares import-preview: refused (unknown_copy_error); no import data was written."
    ) is None
    assert not proof_is_safe({**proof, "rawStderr": "SECRET_SENTINEL"})
    assert not proof_is_safe({**proof, "failureKind": "SECRET_SENTINEL"})
    assert not proof_is_safe({**proof, "failureCategory": "SECRET_SENTINEL"})
    assert not proof_is_safe({**proof, "inspectionCheck": "SECRET_SENTINEL"})
    assert proof["inspectionCheck"] is None
    assert not proof_is_safe({**proof, "status": ["SECRET_SENTINEL"]})
    assert refusal_is_redacted(78, b"lares: the export archive failed inspection; the pinned helper was not run.\n",
                               b"", b"SECRET_SENTINEL")
    assert not refusal_is_redacted(78, b"", b"SECRET_SENTINEL", b"SECRET_SENTINEL")
    expected_dump = ["docker", "exec", "fixture-db", "pg_dump", "-U", "postgres", "--format=custom",
                     "--no-owner", "--no-privileges", "-d", "lares_state"]
    assert custom_dump_argv("fixture-db") == expected_dump
    with __import__("unittest.mock", fromlist=["patch"]).patch(
        "subprocess.run", return_value=subprocess.CompletedProcess(expected_dump, 0, stdout=b"custom-dump")
    ) as mocked_run:
        run(custom_dump_argv("fixture-db"))
        assert mocked_run.call_args.args[0] == expected_dump
    proof["status"] = "passed"
    proof["stage"] = "installed-command"
    assert proof_is_safe(proof)
    with tempfile.TemporaryDirectory(prefix="lares-import-proof-self-test-") as temp:
        proof_path = pathlib.Path(temp) / "proof.json"
        for phase in ("helper-pull", "fixture-db-start", "fixture-db-readiness", "fixture-ledger-seed",
                      "fixture-custom-dump", "fixture-db-remove"):
            sample = fresh_proof()
            with __import__("unittest.mock", fromlist=["patch"]).patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(["hidden"], 37, stdout=b"SECRET_SENTINEL", stderr=b"SECRET_SENTINEL"),
            ):
                try:
                    run(["hidden"], proof=sample, proof_path=proof_path, phase=phase)
                    raise AssertionError("mocked command should fail")
                except ProbeFailure as failure:
                    assert failure.kind == "command-failed"
            saved = proof_path.read_text(encoding="utf-8")
            parsed = json.loads(saved)
            assert parsed["phase"] == phase and parsed["commandExitCode"] == 37
            assert parsed["failureKind"] == "command-failed" and "SECRET_SENTINEL" not in saved
        timeout_sample = fresh_proof()
        with __import__("unittest.mock", fromlist=["patch"]).patch(
            "subprocess.run", side_effect=subprocess.TimeoutExpired(["hidden"], 1, stderr=b"SECRET_SENTINEL")
        ):
            try:
                run(["hidden"], proof=timeout_sample, proof_path=proof_path, phase="fixture-custom-dump")
                raise AssertionError("mocked command should time out")
            except ProbeFailure as failure:
                assert failure.kind == "command-timeout"
        saved = proof_path.read_text(encoding="utf-8")
        parsed = json.loads(saved)
        assert parsed["phase"] == "fixture-custom-dump" and parsed["commandExitCode"] is None
        assert parsed["failureKind"] == "command-timeout" and "SECRET_SENTINEL" not in saved
        installed_path = pathlib.Path(temp) / "installed-proof.json"
        installed = fresh_proof()
        installed["stage"] = "installed-command"
        installed["phase"] = "installed-preview"
        with __import__("unittest.mock", fromlist=["patch"]).patch(
            "subprocess.run", return_value=subprocess.CompletedProcess(
                ["hidden"], 78, stdout=b"", stderr=b"lares import-preview: refused (source_schema_mismatch); no import data was written."
            )
        ):
            try:
                run_installed(["hidden"], env={}, timeout=1, proof=installed, proof_path=installed_path)
                raise AssertionError("mocked installed command should fail")
            except ProbeFailure as failure:
                assert failure.kind == "command-failed"
        parsed = json.loads(installed_path.read_text(encoding="utf-8"))
        assert parsed["stage"] == "installed-command" and parsed["phase"] == "installed-preview"
        assert parsed["commandExitCode"] == 78 and parsed["failureCategory"] == "source-schema-mismatch"
        assert parsed["inspectionCheck"] is None

        member_copy = fresh_proof()
        member_copy["stage"] = "installed-command"
        member_copy["phase"] = "installed-preview"
        with __import__("unittest.mock", fromlist=["patch"]).patch(
            "subprocess.run", return_value=subprocess.CompletedProcess(
                ["hidden"], 78, stdout=b"", stderr=(
                    b"lares import-preview: refused (member_copy_envelope_invalid); no import data was written.\n"
                    b"SECRET_SENTINEL"
                )
            )
        ):
            try:
                run_installed(["hidden"], env={}, timeout=1, proof=member_copy, proof_path=installed_path)
                raise AssertionError("mocked command should fail")
            except ProbeFailure as failure:
                assert failure.kind == "command-failed"
        saved = installed_path.read_text(encoding="utf-8")
        parsed = json.loads(saved)
        assert parsed["failureCategory"] == "member-copy-refused"
        assert parsed["inspectionCheck"] == "member_copy_envelope_invalid"
        assert "SECRET_SENTINEL" not in saved

        inspected = fresh_proof()
        inspected["stage"] = "installed-command"
        inspected["phase"] = "installed-preview"
        with __import__("unittest.mock", fromlist=["patch"]).patch(
            "subprocess.run", return_value=subprocess.CompletedProcess(
                ["hidden"], 78, stdout=b"", stderr=(
                    b"lares import-preview: refused (source_schema_inventory_mismatch); no import data was written.\n"
                    b"lares import-preview inspectionCheck=toc_schema_identifier_invalid\n"
                    b"SECRET_SENTINEL"
                )
            )
        ):
            try:
                run_installed(["hidden"], env={}, timeout=1, proof=inspected, proof_path=installed_path)
                raise AssertionError("mocked installed command should fail")
            except ProbeFailure as failure:
                assert failure.kind == "command-failed"
        saved = installed_path.read_text(encoding="utf-8")
        parsed = json.loads(saved)
        assert parsed["inspectionCheck"] == "toc_schema_identifier_invalid"
        assert "SECRET_SENTINEL" not in saved

        for marker in (
            b"lares import-preview inspectionCheck=unknown\n",
            b"lares import-preview inspectionCheck=toc_schema_identifier_invalid extra\n",
            b"lares import-preview inspectionCheck=toc_schema_identifier_invalid\n"
            b"lares import-preview inspectionCheck=toc_object_type_unsupported\n",
        ):
            malformed = fresh_proof()
            malformed["stage"] = "installed-command"
            malformed["phase"] = "installed-preview"
            with __import__("unittest.mock", fromlist=["patch"]).patch(
                "subprocess.run", return_value=subprocess.CompletedProcess(
                    ["hidden"], 78, stdout=b"", stderr=marker
                )
            ):
                try:
                    run_installed(["hidden"], env={}, timeout=1, proof=malformed, proof_path=installed_path)
                    raise AssertionError("mocked installed command should fail")
                except ProbeFailure:
                    pass
            parsed = json.loads(installed_path.read_text(encoding="utf-8"))
            assert parsed["inspectionCheck"] is None

        schema_inventory = fresh_proof()
        schema_inventory["stage"] = "installed-command"
        schema_inventory["phase"] = "installed-preview"
        with __import__("unittest.mock", fromlist=["patch"]).patch(
            "subprocess.run", return_value=subprocess.CompletedProcess(
                ["hidden"], 78, stdout=b"", stderr=(
                    b"lares import-preview: refused (source_schema_inventory_mismatch); "
                    b"no import data was written. SECRET_SENTINEL"
                )
            )
        ):
            try:
                run_installed(["hidden"], env={}, timeout=1, proof=schema_inventory, proof_path=installed_path)
                raise AssertionError("mocked installed command should fail")
            except ProbeFailure as failure:
                assert failure.kind == "command-failed"
        saved = installed_path.read_text(encoding="utf-8")
        parsed = json.loads(saved)
        assert parsed["failureCategory"] == "source-schema-inventory-mismatch"
        assert "SECRET_SENTINEL" not in saved and "source_schema_inventory_mismatch" not in saved

        unknown = fresh_proof()
        unknown["stage"] = "installed-command"
        unknown["phase"] = "installed-preview"
        with __import__("unittest.mock", fromlist=["patch"]).patch(
            "subprocess.run", return_value=subprocess.CompletedProcess(
                ["hidden"], 1, stdout=b"SECRET_SENTINEL", stderr=b"token=SECRET_SENTINEL"
            )
        ):
            try:
                run_installed(["hidden"], env={}, timeout=1, proof=unknown, proof_path=installed_path)
                raise AssertionError("mocked installed command should fail")
            except ProbeFailure:
                pass
        saved = installed_path.read_text(encoding="utf-8")
        parsed = json.loads(saved)
        assert parsed["commandExitCode"] == 1 and parsed["failureCategory"] == "unknown-output"
        assert "SECRET_SENTINEL" not in saved and "token" not in saved

        timed = fresh_proof()
        timed["stage"] = "installed-command"
        timed["phase"] = "installed-preview"
        with __import__("unittest.mock", fromlist=["patch"]).patch(
            "subprocess.run", side_effect=subprocess.TimeoutExpired(["hidden"], 1, stderr=b"SECRET_SENTINEL")
        ):
            try:
                run_installed(["hidden"], env={}, timeout=1, proof=timed, proof_path=installed_path)
                raise AssertionError("mocked installed command should time out")
            except ProbeFailure as failure:
                assert failure.kind == "command-timeout"
        saved = installed_path.read_text(encoding="utf-8")
        parsed = json.loads(saved)
        assert parsed["commandExitCode"] is None and parsed["failureCategory"] == "command-timeout"
        assert parsed["phase"] == "installed-preview" and "SECRET_SENTINEL" not in saved
        for category in ("output-invalid", "output-assertion-failed"):
            output_failure = fresh_proof()
            output_failure["stage"] = "installed-command"
            output_failure["phase"] = "installed-preview"
            record_installed_output_failure(output_failure, installed_path, category)
            saved = installed_path.read_text(encoding="utf-8")
            parsed = json.loads(saved)
            assert parsed["stage"] == "installed-command" and parsed["phase"] == "installed-preview"
            assert parsed["failureCategory"] == category and parsed["commandExitCode"] is None
            assert "SECRET_SENTINEL" not in saved
    print('{"format":1,"status":"passed","stage":"self-test"}')


def require(condition: bool, kind: str = "assertion-failed") -> None:
    if not condition:
        raise ProbeFailure(kind)


def require_installed(condition: bool, proof: dict[str, object], proof_path: pathlib.Path) -> None:
    if not condition:
        record_installed_output_failure(proof, proof_path, "output-assertion-failed")
        raise ProbeFailure("assertion-failed")


def record_installed_output_failure(proof: dict[str, object], proof_path: pathlib.Path, category: str) -> None:
    if category not in {"output-invalid", "output-assertion-failed"}:
        raise ProbeFailure("unexpected-output")
    proof["failureKind"] = "unexpected-output" if category == "output-invalid" else "assertion-failed"
    proof["failureCategory"] = category
    atomic_proof(proof_path, proof)


def refusal_is_redacted(status: int, stdout: bytes, stderr: bytes, sentinel: bytes) -> bool:
    combined = stdout + stderr
    return status != 0 and sentinel not in combined and b"archive failed inspection" in combined


def install_docker_guard(root: pathlib.Path, image: str) -> tuple[pathlib.Path, pathlib.Path]:
    real_docker = shutil.which("docker")
    require(real_docker is not None, "command-failed")
    bin_dir = root / "guard-bin"
    bin_dir.mkdir()
    events = root / "docker-boundary-events"
    script = bin_dir / "docker"
    script.write_text("""#!/usr/bin/env python3
import os, pathlib, sys
args = sys.argv[1:]
real = os.environ["LARES_PROBE_REAL_DOCKER"]
image = os.environ["LARES_PROBE_KEEPER_REF"]
events = pathlib.Path(os.environ["LARES_PROBE_EVENTS"])
def reject(): raise SystemExit(125)
if "--pull=never" in args:
    if not all(flag in args for flag in ("--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges")):
        reject()
    if "-d" in args or any("docker.sock" in arg or "DATABASE_PASSWORD" in arg for arg in args): reject()
    if "docker.io/pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b" not in args:
        reject()
    if not any(arg.endswith(":/input.tar:ro") for arg in args): reject()
    if not any(arg.endswith(":/output:rw") for arg in args): reject()
    with events.open("a") as out: out.write("helper-safe\\n")
if any("bin/import-preview.ts" in arg for arg in args):
    if not all(flag in args for flag in ("--network", "none", "--read-only")): reject()
    if "-d" in args or any("docker.sock" in arg or "DATABASE_PASSWORD" in arg for arg in args): reject()
    if not any(arg.endswith(":ro") for arg in args if ":" in arg): reject()
    with events.open("a") as out: out.write("keeper-preview-safe\\n")
# These fixed run commands put the image immediately after --entrypoint's value.
# Translate only that operand: unpack also receives the digest as a command argument,
# which must remain intact when it writes the installed engine-image file.
if image in args:
    if not args or args[0] != "run" or "--entrypoint" not in args: reject()
    image_index = args.index("--entrypoint") + 2
    if image_index >= len(args) or args[image_index] != image: reject()
    args[image_index] = "lares-keeper:test"
os.execv(real, [real, *args])
""", encoding="utf-8")
    script.chmod(0o755)
    return bin_dir, events


def migration_sql() -> str:
    checksums = [
        "a2a50ac42a53b25ba28faf41e8b8970354292f131e0e673cb7cc2a0001fa725a",
        "8d1abbab5d997af30f185454aac3a46407bc6d96fde2f555065522fd0df7b58a",
        "a7a43c6ae74466e398935afac6ec379f39ee2ccdf7d4ca8e78b2cdc482949cfa",
        "56c5e04433aa350c9ed7bbed4d7aa0eb533d910f921cba2fe526183ac262dd0b",
        "e1ecab54f9c18c63b057f7970c70fa835ebeb0e09381b6295c4f64a20a91be66",
        "2de295f5c742a004addeb28579d579865bb7832a5d5287be742d0e2e7944827b",
    ]
    names = ["001_baseline.sql", "002_standing_facts.sql", "003_outside_tool_seen.sql",
             "004_web_inbox.sql", "005_model_steps.sql", "006_approval_session.sql"]
    rows = ",\n".join(
        "('%s', %d, '%s', TIMESTAMPTZ '2026-10-21 00:00:00+00', 'applied', 0, %d)"
        % (name, i, checksum, i) for i, (name, checksum) in enumerate(zip(names, checksums), 1)
    )
    return """CREATE TABLE public.users (
      id text PRIMARY KEY, display_name text NOT NULL, primary_email text,
      created_at timestamptz NOT NULL, org_id text NOT NULL, org_role text NOT NULL
    );
    INSERT INTO public.users VALUES ('member-a', 'PRIVATE_NAME_SENTINEL', 'private@example.invalid',
      TIMESTAMPTZ '2026-10-21 00:00:00+00', 'org-a', 'owner');
    CREATE TABLE public.orgs (
      id text PRIMARY KEY, display_name text NOT NULL, created_at timestamptz NOT NULL, domains text[] NOT NULL
    );
    INSERT INTO public.orgs VALUES ('org-a', 'PRIVATE_ORG_LABEL_SENTINEL', TIMESTAMPTZ '2026-10-21 00:00:00+00', ARRAY['example.invalid']);
    CREATE TABLE public.org_member_policy (
      user_id text PRIMARY KEY, allowed_capabilities text[] NOT NULL, may_create_agents boolean NOT NULL,
      spend_cap_usd_month numeric NOT NULL
    );
    INSERT INTO public.org_member_policy VALUES ('member-a', ARRAY['agent:write'], true, 25.00);
    CREATE TABLE public.user_aliases (
      system text NOT NULL, alias text NOT NULL, user_id text NOT NULL, created_at timestamptz NOT NULL,
      PRIMARY KEY (system, alias)
    );
    INSERT INTO public.user_aliases VALUES ('legacy', 'PRIVATE_ALIAS_SENTINEL', 'member-a', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.standing_facts (
      id bigint, fact text, category text, source_turn text, user_id text, stated_at timestamptz,
      retired_at timestamptz, recorded_at timestamptz, source text, origin text, superseded_by bigint
    );
    INSERT INTO public.standing_facts VALUES (1, 'PRIVATE_FACT_SENTINEL', 'preference', 'turn-1', 'member-a',
      TIMESTAMPTZ '2026-10-21 00:00:00+00', NULL, TIMESTAMPTZ '2026-10-21 00:00:00+00', 'remember', 'owner', NULL);
    CREATE TABLE public.memory_proposals (
      id bigint, action text, existing_id text, existing_text text, proposed_text text, subject text, origin text,
      source text, state text, announced_at timestamptz, created_at timestamptz, ref text, kind text
    );
    INSERT INTO public.memory_proposals VALUES (1, 'add', '', '', 'PRIVATE_PROPOSAL_SENTINEL', '', 'agent',
      'dream', 'pending', NULL, TIMESTAMPTZ '2026-10-21 00:00:00+00', 'ref-1', 'preference');
    CREATE TABLE public.memory_reads (session_id text, turn_id text, owner text, kind text, ref text, at timestamptz);
    INSERT INTO public.memory_reads VALUES ('session-1', 'turn-1', 'member-a', 'standing_fact', 'fact-1', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.memory_use (kind text, ref text, owner text, first_used timestamptz, last_used timestamptz, uses integer);
    INSERT INTO public.memory_use VALUES
      ('standing_fact', 'fact-1', 'member-a', TIMESTAMPTZ '2026-10-21 00:00:00+00', TIMESTAMPTZ '2026-10-21 00:00:00+00', 1),
      ('preference', 'ref-2', 'PRIVATE_OWNER_ID_SENTINEL', TIMESTAMPTZ '2026-10-21 00:00:00+00', TIMESTAMPTZ '2026-10-21 00:00:00+00', 1);
    CREATE TABLE public.agent_notes (
      id bigint, owner text, agent text, kind text, note text, origin text, session_id text, turn_id text, at timestamptz
    );
    INSERT INTO public.agent_notes VALUES (1, 'member-a', 'agent-a', 'working', 'PRIVATE_NOTE_SENTINEL', 'owner',
      'session-1', 'turn-1', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.settings (key text, value jsonb, updated_by text, updated_at timestamptz);
    INSERT INTO public.settings VALUES ('private.setting', '{"secret":"PRIVATE_SETTING_SENTINEL"}', 'member-a', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.settings_audit (id bigint, key text, old_value jsonb, new_value jsonb, changed_by text, at timestamptz);
    INSERT INTO public.settings_audit VALUES (1, 'private.setting', NULL, '{"secret":"PRIVATE_AUDIT_SENTINEL"}', 'member-a', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.brief_settings (owner text, language text, updated_by text, updated_at timestamptz);
    INSERT INTO public.brief_settings VALUES ('member-a', 'en', 'member-a', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.deadline_settings (owner text, ladder_enabled boolean, updated_by text, updated_at timestamptz);
    INSERT INTO public.deadline_settings VALUES ('member-a', false, 'member-a', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.proactivity_settings (
      owner text, agent text, door text, quiet_start text, quiet_end text, event_per_door_per_day integer,
      escalation_per_door_per_day integer, per_owner_per_day integer, dnd boolean, updated_by text, updated_at timestamptz
    );
    INSERT INTO public.proactivity_settings VALUES ('member-a', '*', '*', NULL, NULL, 1, 1, 1, false, 'member-a', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.schedule_settings (owner text, schedule text, hours integer[], updated_by text, updated_at timestamptz);
    INSERT INTO public.schedule_settings VALUES ('member-a', 'daily', ARRAY[9], 'member-a', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.conversation_retention (owner text, months integer, updated_by text, updated_at timestamptz);
    INSERT INTO public.conversation_retention VALUES ('member-a', 12, 'member-a', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.forget_ledger (id bigint, owner text, kind text, match_hash text, forgotten_at timestamptz, reason text);
    INSERT INTO public.forget_ledger VALUES (1, 'member-a', 'fact', '%s', TIMESTAMPTZ '2026-10-21 00:00:00+00', 'forget');
    CREATE TABLE public.digest_skips (agent text, path text, reason text, asked_at timestamptz);
    INSERT INTO public.digest_skips VALUES ('agent-a', 'private/path', 'owner request', TIMESTAMPTZ '2026-10-21 00:00:00+00');
    CREATE TABLE public.initiations (
      id bigint, owner text, agent text, door text, cls text, item_key text, status text, reason text,
      until_at timestamptz, owner_day date, decided_at timestamptz, sent_at timestamptz
    );
    INSERT INTO public.initiations VALUES (1, 'member-a', 'agent-a', 'mail', 'scheduled', 'item-1', 'suppressed',
      NULL, NULL, DATE '2026-10-21', TIMESTAMPTZ '2026-10-21 00:00:00+00', NULL);
    CREATE TABLE public.email_triage_processed (
      mailbox text, gmail_message_id text, principal text, outcome text, processed_at timestamptz,
      attempts integer, draft_id text, thread_id text
    );
    INSERT INTO public.email_triage_processed VALUES ('private-mailbox', 'message-1', 'private-principal', 'processed',
      TIMESTAMPTZ '2026-10-21 00:00:00+00', 1, NULL, NULL);
    CREATE TABLE public.schema_migrations (
      filename text PRIMARY KEY, number integer NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), how text NOT NULL,
      took_ms integer NOT NULL DEFAULT 0, seq bigserial NOT NULL
    );
    INSERT INTO public.schema_migrations(filename,number,checksum,applied_at,how,took_ms,seq)
      VALUES %s;""" % (rows, "a" * 64)


def custom_dump_argv(container: str) -> list[str]:
    # docker exec inherits the image's configured OS user; pg_dump/libpq would otherwise
    # infer a database role from that OS name (often root in the Postgres image).
    return ["docker", "exec", container, "pg_dump", "-U", "postgres", "--format=custom",
            "--no-owner", "--no-privileges", "-d", "lares_state"]


def archive_from_dump(dump_path: pathlib.Path, destination: pathlib.Path, *, unsafe: bool = False) -> None:
    files: dict[str, bytes] = {
        "lares_state.dump": dump_path.read_bytes(),
        "postgres.dump": dump_path.read_bytes(),
        "globals.sql": b"-- Synthetic fixture: no global roles or credentials.\n",
    }
    nested_path = pathlib.Path(destination.parent / "agents.tar")
    agent_bytes = b'{"name":"example","role":"neutral"}\n'
    with tarfile.open(nested_path, "w") as nested:
        member = tarfile.TarInfo("agents/../RAW_REFUSAL_SENTINEL" if unsafe else "agents/example/agent.json")
        member.size = len(agent_bytes)
        nested.addfile(member, __import__("io").BytesIO(agent_bytes))
    files["agents.tar"] = nested_path.read_bytes()
    manifest = {
        "engineVersion": "2026-10-21-rc.12",
        "date": "2026-10-21T00:00:00Z",
        "inventoryVersion": 1,
        "files": [
            {"name": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in sorted(files.items())
        ],
        "sourceInventory": {
            "databaseCoverage": "all-nontemplate-databases",
            "databases": [
                {"name": name, "member": name + ".dump", "sha256": hashlib.sha256(files[name + ".dump"]).hexdigest(), "schemas": ["public"]}
                for name in ("lares_state", "postgres")
            ],
            "dataRoots": [{"storeKind": "agent-definitions", "disposition": "included", "member": "agents.tar", "sha256": hashlib.sha256(files["agents.tar"]).hexdigest()}],
            "dataSelection": "configured",
            "absentDataRoots": [{"storeKind": "installation-inventory", "disposition": "absent"}],
            "vaultRepositories": [],
            "vaultSelection": "configured-empty",
            "supportFiles": [{"kind": "postgres-roles-without-passwords", "member": "globals.sql", "sha256": hashlib.sha256(files["globals.sql"]).hexdigest()}],
            "protectedMaterial": {"credentialFiles": "excluded", "encryptedDatabaseCredentials": "may-be-present", "ordinaryImport": "blocked"},
            "unverified": ["stores outside the configured export paths", "database table and row contents beyond the declared schema names", "source-version compatibility and identity mappings"],
        },
    }
    files["manifest.json"] = json.dumps(manifest, separators=(",", ":")).encode()
    with tarfile.open(destination, "w") as outer:
        root = tarfile.TarInfo("./")
        root.type = tarfile.DIRTYPE
        outer.addfile(root)
        for name, data in files.items():
            member = tarfile.TarInfo("./" + name)
            member.size = len(data)
            outer.addfile(member, __import__("io").BytesIO(data))


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if os.environ.get("CI") != "true" or os.geteuid() != 0:
        print("Import preview image proof runs only in isolated CI as root", file=sys.stderr)
        return 2
    if len(sys.argv) != 4:
        print("usage: import-preview-image.probe.py <keeper-image-digest-ref> <source-sha> <proof.json>", file=sys.stderr)
        return 2

    image, source_sha, proof_arg = sys.argv[1:]
    if len(source_sha) != 40 or any(c not in "0123456789abcdef" for c in source_sha.lower()):
        print("Import preview proof needs the checked-out source identity", file=sys.stderr)
        return 2
    proof_path = pathlib.Path(proof_arg)
    proof = fresh_proof()
    root: pathlib.Path | None = None
    db_name = "lares-import-preview-" + uuid.uuid4().hex[:12]
    db_started = False
    try:
        atomic_proof(proof_path, proof)
        root = pathlib.Path(tempfile.mkdtemp(prefix="lares-import-preview-proof-")).resolve()
        root.chmod(0o755)
        guard_bin, boundary_events = install_docker_guard(root, image)
        env = dict(os.environ)
        env["PATH"] = str(guard_bin) + os.pathsep + env.get("PATH", "")
        env["LARES_PROBE_REAL_DOCKER"] = shutil.which("docker") or ""
        env["LARES_PROBE_KEEPER_REF"] = image
        env["LARES_PROBE_EVENTS"] = str(boundary_events)
        releases = root / "prefix/opt/lares/releases"
        releases.mkdir(parents=True)
        prefix = root / "prefix"
        archive = root / "synthetic-export.tar"
        dump_path = root / "lares_state.dump"
        run(["docker", "pull", PINNED_DB_IMAGE], proof=proof, proof_path=proof_path, phase="helper-pull")
        run(["docker", "run", "--detach", "--rm", "--network", "none", "--name", db_name,
             "--tmpfs", "/var/lib/postgresql/data:rw,size=1g", "--env", "POSTGRES_PASSWORD=fixture-only",
             "--env", "POSTGRES_DB=lares_state", PINNED_DB_IMAGE], proof=proof, proof_path=proof_path,
            phase="fixture-db-start")
        db_started = True
        set_phase(proof, proof_path, "fixture-db-readiness")
        ready = False
        readiness_exit = 1
        for _ in range(60):
            probe = subprocess.run(["docker", "exec", db_name, "pg_isready", "-U", "postgres", "-d", "lares_state"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            readiness_exit = probe.returncode
            if probe.returncode == 0:
                ready = True
                break
            time.sleep(1)
        proof["commandExitCode"] = None if ready else max(0, min(255, readiness_exit))
        if not ready:
            proof["failureKind"] = "command-failed"
            atomic_proof(proof_path, proof)
        require(ready, "command-failed")
        run(["docker", "exec", "-i", db_name, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "lares_state"],
            input_text=migration_sql(), proof=proof, proof_path=proof_path, phase="fixture-ledger-seed")
        with dump_path.open("wb") as output:
            run(custom_dump_argv(db_name), stdout=output, proof=proof, proof_path=proof_path,
                phase="fixture-custom-dump")
        run(["docker", "rm", "--force", db_name], stdout=subprocess.DEVNULL, proof=proof,
            proof_path=proof_path, phase="fixture-db-remove")
        db_started = False
        archive_from_dump(dump_path, archive)
        proof["checks"]["syntheticCustomDump"] = True  # type: ignore[index]
        proof["stage"] = "unpack"
        atomic_proof(proof_path, proof)

        digest = image
        set_phase(proof, proof_path, "image-unpack")
        run(["docker", "run", "--rm", "--network", "none", "--user", f"{os.getuid()}:{os.getgid()}",
             "--env", "OUT_ROOT=/out", "--mount", f"type=bind,src={releases},dst=/out",
             "--entrypoint", "bash", digest, "/app/services/box/ops/unpack-engine.sh", "ci-import-preview", digest],
            env=env)
        current = prefix / "opt/lares/current"
        current.symlink_to(releases / "ci-import-preview")
        installed = current / "services/box/ops/lares"
        require(installed.is_file(), "unexpected-output")
        proof["stage"] = "installed-command"
        atomic_proof(proof_path, proof)

        env["LARES_PREFIX"] = str(prefix)
        env["TMPDIR"] = str(root)
        env.pop("LARES_ENGINE_IMAGE", None)
        proof["stage"] = "installed-command"
        set_phase(proof, proof_path, "installed-preview")
        valid = run_installed([str(installed), "import-preview", str(archive)], env=env,
                              timeout=180, proof=proof, proof_path=proof_path)
        try:
            result = json.loads(valid.stdout)
        except Exception:
            record_installed_output_failure(proof, proof_path, "output-invalid")
            raise ProbeFailure("unexpected-output") from None
        categories = result.get("categories") if isinstance(result, dict) else None
        require_installed(isinstance(result, dict) and result.get("status") == "inspection-only"
                          and result.get("importReadiness") == "blocked", proof, proof_path)
        require_installed(isinstance(categories, list) and len(categories) == 22, proof, proof_path)
        require_installed([entry.get("category") for entry in categories] == CATEGORIES, proof, proof_path)
        member_category = categories[0]
        require_installed(member_category.get("status") == "partially-inventoried"
                          and member_category.get("count") == 1
                          and isinstance(member_category.get("checksum"), str)
                          and member_category.get("unresolvedMemberIds") == ["member-a"]
                          and member_category.get("unresolvedOrganisationIds") == ["org-a"]
                          and len(member_category.get("sourceTables", [])) == 4, proof, proof_path)
        require_installed(categories[8].get("category") == "facts"
                          and categories[8].get("status") == "partially-inventoried"
                          and categories[8].get("count") == 6
                          and categories[8].get("dependencies", {}).get("rowsWithoutExplicitMemberOwner") == 1
                          and categories[8].get("dependencies", {}).get("ownerReferencesWithoutMemberIdentity") == 1,
                          proof, proof_path)
        require_installed(categories[15].get("category") == "settings"
                          and categories[15].get("status") == "partially-inventoried"
                          and categories[15].get("count") == 7,
                          proof, proof_path)
        require_installed(categories[18].get("category") == "suppression"
                          and categories[18].get("status") == "partially-inventoried"
                          and categories[18].get("count") == 4,
                          proof, proof_path)
        require_installed(all(entry.get("status") == "not-inventoried" and entry.get("count") is None
                              and entry.get("checksum") is None for entry in categories[1:]
                              if entry.get("category") not in {"facts", "settings", "suppression"}), proof, proof_path)
        inventory = result.get("sourceInventory")
        require_installed(isinstance(inventory, dict)
                          and [item.get("name") for item in inventory.get("databases", [])] == ["lares_state", "postgres"]
                          and all(item.get("schemas") == ["public"] for item in inventory.get("databases", []))
                          and inventory.get("protectedMaterial", {}).get("ordinaryImport") == "blocked", proof, proof_path)
        valid_text = valid.stdout.decode("utf-8", "replace")
        require_installed(all(sentinel not in valid_text for sentinel in
                              ("RAW_REFUSAL_SENTINEL", "PRIVATE_NAME_SENTINEL", "private@example.invalid",
                               "PRIVATE_ORG_LABEL_SENTINEL", "PRIVATE_ALIAS_SENTINEL", "agent:write", "25.00",
                               "PRIVATE_FACT_SENTINEL", "PRIVATE_PROPOSAL_SENTINEL", "PRIVATE_NOTE_SENTINEL",
                               "PRIVATE_SETTING_SENTINEL", "PRIVATE_AUDIT_SENTINEL", "private.setting",
                               "PRIVATE_OWNER_ID_SENTINEL", "private-mailbox", "private-principal")), proof, proof_path)
        member_map = root / "member-map.json"
        member_map.write_text(json.dumps({
            "version": 1,
            "members": [{"sourceId": "member-a", "destinationId": "mapped-member-a"}],
            "organizations": [{"sourceId": "org-a", "destinationId": "mapped-org-a"}],
        }), encoding="utf-8")
        member_map.chmod(0o400)
        mapped = run_installed([str(installed), "import-preview", str(archive), "--member-map", str(member_map)],
                               env=env, timeout=180, proof=proof, proof_path=proof_path)
        try:
            mapped_result = json.loads(mapped.stdout)
        except Exception:
            record_installed_output_failure(proof, proof_path, "output-invalid")
            raise ProbeFailure("unexpected-output") from None
        mapped_categories = mapped_result.get("categories") if isinstance(mapped_result, dict) else None
        require_installed(isinstance(mapped_categories, list) and len(mapped_categories) == len(CATEGORIES), proof, proof_path)
        require_installed(mapped_categories[0].get("status") == "inventoried"
                          and mapped_categories[0].get("sourceMembers") == [{
                              "sourceId": "member-a", "destinationId": "mapped-member-a",
                              "provenance": "explicit-import-map",
                          }]
                          and mapped_categories[0].get("sourceOrganisations") == [{
                              "sourceId": "org-a", "destinationId": "mapped-org-a",
                              "provenance": "explicit-import-map",
                          }], proof, proof_path)
        require_installed(mapped_result.get("importReadiness") == "blocked"
                          and mapped_categories[1].get("status") == "not-inventoried"
                          and mapped_categories[8].get("status") == "partially-inventoried"
                          and mapped_categories[8].get("ownerMappings") == [{
                              "sourceId": "member-a", "destinationId": "mapped-member-a",
                              "provenance": "explicit-import-map",
                          }]
                          and mapped_categories[15].get("status") == "partially-inventoried"
                          and mapped_categories[18].get("status") == "partially-inventoried"
                          and "destination existence and authority are not verified" in mapped_categories[0].get("authority", ""),
                          proof, proof_path)
        mapped_text = mapped.stdout.decode("utf-8", "replace")
        require_installed(all(sentinel not in mapped_text for sentinel in
                              ("RAW_REFUSAL_SENTINEL", "PRIVATE_NAME_SENTINEL", "private@example.invalid",
                               "PRIVATE_ORG_LABEL_SENTINEL", "PRIVATE_ALIAS_SENTINEL", "agent:write", "25.00",
                               "PRIVATE_FACT_SENTINEL", "PRIVATE_PROPOSAL_SENTINEL", "PRIVATE_NOTE_SENTINEL",
                               "PRIVATE_SETTING_SENTINEL", "PRIVATE_AUDIT_SENTINEL", "private.setting",
                               "PRIVATE_OWNER_ID_SENTINEL", "private-mailbox", "private-principal")), proof, proof_path)
        events_before_refusal = boundary_events.read_text(encoding="utf-8").splitlines()
        require(events_before_refusal.count("helper-safe") == 2)
        require(events_before_refusal.count("keeper-preview-safe") >= 3)
        require(not list(root.glob("lares-import-preview.*")), "cleanup-failed")
        proof["checks"]["actualInstalledCommand"] = True  # type: ignore[index]
        proof["checks"]["remainingCategoriesRemainUninventoried"] = True  # type: ignore[index]
        proof["checks"]["ownedRecordGroupsRedacted"] = True  # type: ignore[index]
        proof["checks"]["helperRanOfflineWithReadOnlyInput"] = True  # type: ignore[index]

        proof["stage"] = "refusal"
        set_phase(proof, proof_path, "unsafe-archive-refusal")
        unsafe_archive = root / "unsafe-export.tar"
        archive_from_dump(dump_path, unsafe_archive, unsafe=True)
        refused = subprocess.run([str(installed), "import-preview", str(unsafe_archive)], env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
        refusal_text = refused.stdout + refused.stderr
        require(refusal_is_redacted(refused.returncode, refused.stdout, refused.stderr, b"RAW_REFUSAL_SENTINEL"), "unexpected-output")
        events_after_refusal = boundary_events.read_text(encoding="utf-8").splitlines()
        require(events_after_refusal.count("helper-safe") == events_before_refusal.count("helper-safe"))
        require(not list(root.glob("lares-import-preview.*")), "cleanup-failed")
        proof["checks"]["unsafeArchiveRefusedAndRedacted"] = True  # type: ignore[index]
        proof["stage"] = "cleanup"
        set_phase(proof, proof_path, "cleanup")
        shutil.rmtree(root)
        root = None
        require(not pathlib.Path(env["TMPDIR"]).exists(), "cleanup-failed")
        proof["checks"]["scratchRemoved"] = True  # type: ignore[index]
        proof["cleanupOkay"] = True
        proof["status"] = "passed"
        proof["stage"] = "cleanup"
        atomic_proof(proof_path, proof)
        return 0
    except ProbeFailure as exc:
        proof["status"] = "failed"
        proof["failureKind"] = exc.kind
        if proof.get("failureCategory") is None and proof.get("phase") == "installed-preview":
            proof["failureCategory"] = "unknown-output"
    except Exception:
        proof["status"] = "failed"
        proof["failureKind"] = "unexpected-output"
        if proof.get("phase") == "installed-preview":
            proof["failureCategory"] = "unknown-output"
    finally:
        cleanup_ok = True
        if db_started:
            cleanup = subprocess.run(["docker", "rm", "--force", db_name], stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, check=False)
            cleanup_ok = cleanup.returncode == 0
        if root is not None:
            try:
                shutil.rmtree(root)
            except Exception:
                cleanup_ok = False
        proof["cleanupOkay"] = cleanup_ok
        if not cleanup_ok:
            proof["failureKind"] = "cleanup-failed"
            proof["status"] = "failed"
    if proof["status"] == "failed":
        atomic_proof(proof_path, proof)
        print("Import preview image proof failed; see the bounded proof artifact", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
