#!/usr/bin/env python3
"""One line for `lares doctor`: the state of the financial ledger on this host.

Reads the ledger files and changes nothing. It prints nothing when spending has not been set up.
Exit codes: 0 fine or nothing to report · 1 the owner has something to do.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

BOOK_BYTES = 8 * 1024 * 1024
LOW_DISK_BYTES = 256 * 1024 * 1024
BOOK_NAME = re.compile(r"^journal(-[0-9]{6})?\.jsonl$")


def size(bytes_: int) -> str:
    return f"{bytes_ / (1024 ** 3):.1f} GB" if bytes_ >= 1024**3 else f"{bytes_ / (1024 ** 2):.0f} MB"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", default="/")
    custody = Path(parser.parse_args().prefix) / "var/lib/lares/budget-financial"
    if not os.path.lexists(custody):
        return 0
    try:
        books = sorted(path for path in custody.iterdir() if BOOK_NAME.match(path.name))
        if not books:
            print("ledger: PROBLEM. The ledger folder has no ledger files. Recovery is required; see docs/budget-financial-journal.md.")
            return 1
        # Book 1 is journal.jsonl, which sorts after journal-000002.jsonl, so order by name length first.
        current = max(books, key=lambda path: (len(path.name), path.name))
        lines = current.read_text(encoding="utf-8").splitlines()
        frozen = any(json.loads(line)["record"]["kind"] == "freeze" for line in lines)
        used = sum(path.stat().st_size for path in books)
        full = current.stat().st_size * 100 // BOOK_BYTES
        disk = os.statvfs(custody)
    except PermissionError:
        print("ledger: run `sudo lares doctor` to read the ledger's state.")
        return 0
    except (OSError, ValueError, KeyError, TypeError):
        print("ledger: PROBLEM. The ledger could not be read. Do not change its files; see docs/budget-financial-journal.md.")
        return 1
    free = disk.f_bavail * disk.f_frsize
    if frozen:
        print("ledger: PROBLEM. The ledger has frozen itself, so model spending is stopped. Recovery is required; see docs/budget-financial-journal.md.")
        return 1
    if free < LOW_DISK_BYTES:
        print(f"ledger: PROBLEM. Only {size(free)} of disk is free. Spending stops when the current book fills up unless more space is freed.")
        return 1
    print(f"ledger: ok. Book {len(books)} is {full}% full, {size(used)} used, {size(free)} free on disk.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
