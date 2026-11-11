#!/usr/bin/env python3
"""workflow-backup-layout.py: which layout an agent store has INSIDE a backup, read before restore changes anything.

  workflow-backup-layout.py <lib/workflow-database-privileges.ts> <ops/workflow-store-migrate.mjs> <toc> <data>

<toc> is `pg_restore -l` of one agent store's dump. <data> is
`pg_restore --data-only -n workflow_drizzle -n graphile_worker -t workflow_migrations -t migrations -f -`
of the same dump. Neither needs a database: pg_restore only reads the archive.

Prints exactly one word and exits 0:
  current  the store has exactly this release's list of schema steps
  old      it has exactly what the previous release left, so this release can upgrade it
Anything else exits 3 with one plain sentence on standard error (what was found); the restore
then refuses before anything is dropped. Exit 1: this release's own files could not be read.

It applies the same rules as the store's own check (ops/workflow-store-migrate.mjs, `check`), to
the backup instead of a live database: the step record, the tables the newer steps add, and the
job queue's record. The lists come from this release's own files, never from a copy here.
"""
import re
import sys


def fail(message, code=3):
    sys.stderr.write(message + "\n")
    raise SystemExit(code)


def release_lists(lib_path, program_path):
    try:
        lib = open(lib_path, encoding="utf-8").read()
        program = open(program_path, encoding="utf-8").read()
    except OSError:
        fail("this release's list of agent store schema steps could not be read", 1)
    block = re.search(r"WORKFLOW_SCHEMA_STEPS:[^=]*=\s*\[(.*?)\n\];", lib, re.S)
    before = re.search(r"WORKFLOW_SCHEMA_STEPS_BEFORE\s*=\s*(\d+);", lib)
    left = re.search(r"LEFT_BY_PREVIOUS_RELEASE\s*=\s*\[(.*?)\];", program, re.S)
    added = re.search(r"ADDED_BY_THIS_RELEASE\s*=\s*\[(.*?)\];", program, re.S)
    queue = re.search(r"QUEUE_STEPS\s*=\s*(\d+);", program)
    if not (block and before and left and added and queue):
        fail("this release's list of agent store schema steps could not be read", 1)
    full = [f"{when} {digest}" for when, digest in re.findall(r'\["(\d{13})",\s*"([0-9a-f]{64})"\]', block.group(1))]
    old = re.findall(r'"(\d{13} [0-9a-f]{64})"', left.group(1))
    count = int(before.group(1))
    if not full or count < 1 or count >= len(full) or old != full[:count]:
        fail("this release's two lists of agent store schema steps disagree", 1)
    return full, old, re.findall(r'"([a-z_]+\.[a-z_]+)"', added.group(1)), int(queue.group(1))


def copy_blocks(text):
    """{ 'schema.table': [ {column: value} ] } for every COPY block in pg_restore's text output."""
    tables, current, columns = {}, None, []
    for line in text.split("\n"):
        if current is None:
            found = re.match(r"^COPY ([a-z_]+\.[a-z_]+) \(([^)]*)\) FROM stdin;$", line)
            if found:
                current = found.group(1)
                columns = [name.strip().strip('"') for name in found.group(2).split(",")]
                tables[current] = []
            continue
        if line == "\\.":
            current = None
            continue
        values = line.split("\t")
        if len(values) != len(columns):
            fail("its record of schema steps is in a form this release does not know")
        tables[current].append(dict(zip(columns, values)))
    if current is not None:
        fail("its record of schema steps ends part-way, so the backup file may be damaged")
    return tables


def main():
    if len(sys.argv) != 5:
        fail("usage: workflow-backup-layout.py <lib> <program> <toc> <data>", 1)
    full, old, added, queue_steps = release_lists(sys.argv[1], sys.argv[2])
    try:
        toc = open(sys.argv[3], encoding="utf-8", errors="replace").read()
        data = open(sys.argv[4], encoding="utf-8", errors="replace").read()
    except OSError:
        fail("its contents could not be read out of the backup")
    present = set()
    for line in toc.split("\n"):
        if line.startswith(";"):
            continue
        found = re.search(r"\b(TABLE|SEQUENCE) ([a-z_]+) ([a-z_]+) ", line)
        if found:
            present.add(f"{found.group(2)}.{found.group(3)}")
    tables = copy_blocks(data)
    steps = tables.get("workflow_drizzle.workflow_migrations")
    if steps is None:
        if "workflow_drizzle.workflow_migrations" in present:
            fail("its record of schema steps could not be read out of the backup")
        fail("it holds no record of the agent framework's schema steps, so I cannot tell which release wrote it")
    try:
        recorded = [f"{row['created_at']} {row['hash']}" for row in sorted(steps, key=lambda row: int(row["id"]))]
    except (KeyError, ValueError):
        fail("its record of schema steps is in a form this release does not know")
    is_current, is_old = recorded == full, recorded == old
    if not is_current and not is_old:
        if len(recorded) > len(full) and recorded[:len(full)] == full:
            fail(f"it was written by a newer release: it has {len(recorded)} schema steps recorded, and this release knows {len(full)}")
        fail(f"it has {len(recorded)} schema steps recorded, and they are neither the {len(old)} an older release leaves "
             f"nor the {len(full)} this release leaves")
    have = sum(1 for name in added if name in present)
    if is_old and have != 0:
        fail("its record says it was written by an older release, but it already has tables this release adds")
    if is_current and have != len(added):
        fail("its record says it was written by this release, but tables this release adds are missing")
    queue = tables.get("graphile_worker.migrations")
    if queue is None:
        fail("it has no job queue record, so I cannot tell which release wrote it")
    try:
        ids = sorted(int(row["id"]) for row in queue)
    except (KeyError, ValueError):
        fail("its job queue record is in a form this release does not know")
    if ids != list(range(1, queue_steps + 1)):
        fail(f"its job queue is at a version this release does not know ({len(ids)} steps recorded, {queue_steps} expected)")
    print("current" if is_current else "old")


main()
