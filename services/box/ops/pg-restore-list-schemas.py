#!/usr/bin/env python3
"""Extract dump-observed schemas from bounded pg_restore --list metadata."""
import json
import re
import shlex
import sys


MAX_TOC_BYTES = 256 * 1024
TOC_ENTRY = re.compile(r"^[0-9]+;[ \t]+[0-9]+[ \t]+[0-9]+[ \t]+(.*)$")
SAFE_SCHEMA = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
PARSER_CHECKS = {
    "toc_too_large", "toc_encoding_invalid", "toc_archive_header_missing",
    "toc_selection_header_missing", "toc_entry_format_invalid",
    "toc_tokenization_failed", "toc_entry_tokens_empty",
    "toc_security_wrapper_invalid", "toc_comment_acl_wrapper_invalid",
    "toc_wrapped_object_missing", "toc_wrapped_schema_invalid",
    "toc_schema_declaration_invalid", "toc_default_acl_invalid",
    "toc_namespace_object_incomplete", "toc_global_object_invalid",
    "toc_object_type_unsupported", "toc_schema_identifier_invalid",
    "toc_explicit_schema_duplicate", "toc_entries_missing",
    "parser_internal_failure",
}


class DiagnosticFailure(Exception):
    def __init__(self, inspection_check):
        self.inspection_check = inspection_check if inspection_check in PARSER_CHECKS else "parser_internal_failure"

# These pg_restore object descriptions put the owning schema immediately after
# the type label. Multiword labels must be checked before their shorter forms.
NAMESPACE_TYPES = sorted((
    ("TEXT", "SEARCH", "CONFIGURATION"), ("TEXT", "SEARCH", "DICTIONARY"),
    ("TEXT", "SEARCH", "PARSER"), ("TEXT", "SEARCH", "TEMPLATE"),
    ("MATERIALIZED", "VIEW"), ("FOREIGN", "TABLE"),
    ("OPERATOR", "CLASS"), ("OPERATOR", "FAMILY"), ("TABLE", "ATTACH"),
    ("TABLE", "DATA"),
    ("SEQUENCE", "OWNED", "BY"), ("SEQUENCE", "SET"),
    ("AGGREGATE",), ("COLLATION",), ("CONVERSION",), ("CONSTRAINT",),
    ("DEFAULT",), ("DOMAIN",), ("FUNCTION",), ("INDEX",), ("POLICY",),
    ("PROCEDURE",), ("RULE",), ("SEQUENCE",), ("STATISTICS",),
    ("TABLE",), ("TRIGGER",), ("TYPE",), ("VIEW",),
), key=len, reverse=True)

GLOBAL_TYPES = (
    ("DATABASE", "PROPERTIES"), ("DATABASE",), ("EXTENSION",),
    ("EVENT", "TRIGGER"), ("LANGUAGE",), ("PROCEDURAL", "LANGUAGE"),
    ("PUBLICATION",), ("SUBSCRIPTION",), ("BLOB", "COMMENTS"),
    ("BLOB", "ACL"), ("BLOB",), ("ENCODING",), ("STDSTRINGS",),
    ("SEARCHPATH",),
)


def starts_with(tokens, label):
    return tuple(tokens[:len(label)]) == label


def object_schema(tokens):
    # COMMENT, ACL, and SECURITY LABEL wrap a second object's description.
    if tokens and tokens[0] in {"COMMENT", "ACL", "SECURITY"}:
        if tokens[0] == "SECURITY":
            if len(tokens) < 3 or tokens[1:3] != ["LABEL", "-"]:
                raise DiagnosticFailure("toc_security_wrapper_invalid")
            tokens = tokens[3:]
        else:
            if len(tokens) < 3 or tokens[1] != "-":
                raise DiagnosticFailure("toc_comment_acl_wrapper_invalid")
            tokens = tokens[2:]
        if not tokens:
            raise DiagnosticFailure("toc_wrapped_object_missing")
        if tokens[0] in {"DATABASE", "EXTENSION", "LANGUAGE", "PROCEDURAL"}:
            return None
        if tokens[0] == "SCHEMA":
            if len(tokens) < 3 or tokens[1] != "-":
                raise DiagnosticFailure("toc_wrapped_schema_invalid")
            return checked_schema(tokens[2], "toc_wrapped_schema_invalid")

    if tokens and tokens[0] == "SCHEMA":
        if len(tokens) < 3 or tokens[1] != "-":
            raise DiagnosticFailure("toc_schema_declaration_invalid")
        return checked_schema(tokens[2], "toc_schema_declaration_invalid")

    if starts_with(tokens, ("DEFAULT", "ACL")):
        if len(tokens) < 4 or tokens[2] != "-":
            raise DiagnosticFailure("toc_default_acl_invalid")
        return checked_schema(tokens[3], "toc_default_acl_invalid")

    for label in NAMESPACE_TYPES:
        if starts_with(tokens, label):
            index = len(label)
            if len(tokens) < index + 2:
                raise DiagnosticFailure("toc_namespace_object_incomplete")
            return checked_schema(tokens[index], "toc_schema_identifier_invalid")

    for label in GLOBAL_TYPES:
        if starts_with(tokens, label):
            index = len(label)
            if len(tokens) < index + 2 or tokens[index] != "-":
                raise DiagnosticFailure("toc_global_object_invalid")
            return None
    raise DiagnosticFailure("toc_object_type_unsupported")


def checked_schema(schema, inspection_check):
    if not SAFE_SCHEMA.fullmatch(schema):
        raise DiagnosticFailure(inspection_check)
    return schema


def parse(stream):
    raw = stream.buffer.read(MAX_TOC_BYTES + 1)
    if len(raw) > MAX_TOC_BYTES:
        raise DiagnosticFailure("toc_too_large")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise DiagnosticFailure("toc_encoding_invalid") from None
    lines = text.splitlines()
    if not any(line.startswith("; Archive created at ") for line in lines):
        raise DiagnosticFailure("toc_archive_header_missing")
    if "; Selected TOC Entries:" not in lines:
        raise DiagnosticFailure("toc_selection_header_missing")
    schemas = set()
    explicit_schemas = set()
    saw_entry = False
    for line in lines:
        if not re.match(r"^[0-9]+;", line):
            continue
        saw_entry = True
        entry = TOC_ENTRY.fullmatch(line)
        if not entry:
            raise DiagnosticFailure("toc_entry_format_invalid")
        try:
            tokens = shlex.split(entry.group(1), posix=True)
        except ValueError:
            raise DiagnosticFailure("toc_tokenization_failed") from None
        if not tokens:
            raise DiagnosticFailure("toc_entry_tokens_empty")
        schema = object_schema(tokens)
        if schema is not None:
            schemas.add(schema)
            if tokens[0] == "SCHEMA":
                if schema in explicit_schemas:
                    raise DiagnosticFailure("toc_explicit_schema_duplicate")
                explicit_schemas.add(schema)
    if not saw_entry:
        raise DiagnosticFailure("toc_entries_missing")
    return sorted(schemas)


try:
    print(json.dumps({"schemas": parse(sys.stdin)}, separators=(",", ":")))
except DiagnosticFailure as failure:
    print(json.dumps({"error": "unsupported_schema_metadata", "inspectionCheck": failure.inspection_check}, separators=(",", ":")))
    sys.exit(1)
except Exception:
    print('{"error":"unsupported_schema_metadata","inspectionCheck":"parser_internal_failure"}')
    sys.exit(1)
