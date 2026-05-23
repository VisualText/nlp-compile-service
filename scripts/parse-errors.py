#!/usr/bin/env python3
"""
Parse a CMake/compiler build log into the structured errors[] array
defined in the compile-service manifest schema.

For each error/warning the parser emits {file, line, column?, severity,
message}. If the referenced .cpp file contains a Tier-1 provenance
comment of the form `// nlp-source: <path>:<line>` above the error
line, we attach `nlpSourceFile` / `nlpSourceLine` so the extension
can surface the error in the originating .nlp file.

Compilers covered:
  GCC/Clang   path/file.cpp:LINE:COL: severity: message
              path/file.cpp:LINE: severity: message
  MSVC        path\\file.cpp(LINE,COL): severity CODE: message
              path\\file.cpp(LINE): severity CODE: message

Usage:
  python3 parse-errors.py --log <buildlog> --anapath <dir> --out <json>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Optional

GCC_RE = re.compile(
    r"^(?P<file>[^:\n][^:\n]*\.(?:cpp|cc|cxx|h|hpp))"
    r":(?P<line>\d+)(?::(?P<col>\d+))?"
    r":\s*(?P<sev>error|warning|fatal error|note)"
    r":\s*(?P<msg>.+)$",
    re.IGNORECASE,
)

MSVC_RE = re.compile(
    r"^(?P<file>[A-Za-z]:\\[^\(]+?|[^\(]+?\\[^\(]+?\.(?:cpp|cc|cxx|h|hpp))"
    r"\((?P<line>\d+)(?:,(?P<col>\d+))?\)"
    r"\s*:\s*(?P<sev>error|warning|fatal error)"
    r"\s+[A-Z]+\d+\s*:\s*(?P<msg>.+)$",
    re.IGNORECASE,
)

# Per-construct anchor — line only; file is inherited from the file anchor.
PROVENANCE_LINE_RE = re.compile(r"^\s*//\s*nlp-source:\s*(?P<line>\d+)\s*$")
# File anchor — emitted once at the top of each generated pass{N}.cpp.
PROVENANCE_FILE_RE = re.compile(r"^\s*//\s*nlp-source-file:\s*(?P<file>.+?)\s*$")


def find_provenance(cpp_path: str, error_line: int, anapath: str) -> Optional[tuple[str, int]]:
    """Walk backward from error_line to find the nearest per-construct
    `// nlp-source: <line>` and (continuing further back) the file-level
    `// nlp-source-file: <path>` anchor. Returns (relpath, line) where
    relpath is made relative to anapath when possible."""
    try:
        with open(cpp_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return None

    found_line: Optional[int] = None
    found_file: Optional[str] = None
    upper = min(error_line, len(lines))
    for i in range(upper - 1, -1, -1):
        if found_line is None:
            m = PROVENANCE_LINE_RE.match(lines[i])
            if m:
                found_line = int(m.group("line"))
                continue
        m = PROVENANCE_FILE_RE.match(lines[i])
        if m:
            found_file = m.group("file").strip()
            break

    if found_line is None or found_file is None:
        return None

    # Normalize: convert backslashes (Windows engine output) and try to make
    # the path relative to anapath so the extension can map it to a workspace file.
    norm = found_file.replace("\\", "/")
    if os.path.isabs(norm):
        try:
            norm = os.path.relpath(norm, anapath).replace("\\", "/")
        except ValueError:
            pass  # different drive on Windows; keep absolute
    return norm, found_line


def normalize_severity(raw: str) -> str:
    raw = raw.lower()
    if "warning" in raw:
        return "warning"
    if "note" in raw:
        return "note"
    return "error"


def parse_log(log_path: str, anapath: str) -> list[dict]:
    errors: list[dict] = []
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\r\n")
            m = GCC_RE.match(line) or MSVC_RE.match(line)
            if not m:
                continue

            file_ref = m.group("file").strip()
            file_abs = file_ref if os.path.isabs(file_ref) else os.path.join(anapath, file_ref)

            entry: dict = {
                "file": os.path.relpath(file_abs, anapath) if os.path.exists(file_abs) else file_ref,
                "line": int(m.group("line")),
                "severity": normalize_severity(m.group("sev")),
                "message": m.group("msg").strip(),
            }
            if m.group("col"):
                entry["column"] = int(m.group("col"))

            prov = find_provenance(file_abs, int(m.group("line")), anapath)
            if prov:
                entry["nlpSourceFile"] = prov[0]
                entry["nlpSourceLine"] = prov[1]

            errors.append(entry)
    return errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--anapath", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if not os.path.exists(args.log):
        print(f"parse-errors.py: log not found: {args.log}", file=sys.stderr)
        return 2

    errors = parse_log(args.log, args.anapath)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(errors, f, indent=2)
    print(f"parse-errors.py: wrote {len(errors)} entries to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
