#!/usr/bin/env -S uv run --python 3.13 --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["baml-lib"]
# ///
"""parse-worker-output.py — lenient JSON validator for moonbit-housekeeping workers.

Uses baml-lib's schema-aligned parser (parse-only mode) to extract validated JSON
from worker output that may contain preamble prose, code-fence wrappers, or trailing
commentary.

Usage:
  echo "$worker_raw_output" | parse-worker-output.py --root Changelog
  parse-worker-output.py --root ApiReview --input worker.txt
  parse-worker-output.py --root DocDrift --schema /path/to/custom.baml
  parse-worker-output.py --root ReviewFindings --input review-worker.txt

Exit codes:
  0 — parsed and validated; clean JSON on stdout
  1 — parse/validation failed; PARSE_ERROR diagnostic on stderr
  2 — usage error
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_SCHEMA = Path(__file__).parent / "schemas.baml"
CLASS_DECL = re.compile(r"^class\s+(\w+)\s*\{", re.MULTILINE)


def discover_root_classes(schema_text: str) -> set[str]:
    return set(CLASS_DECL.findall(schema_text))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--root", required=True, help="Root class name (e.g. Changelog, ApiReview, DocDrift, ReviewFindings)")
    p.add_argument("--schema", default=str(DEFAULT_SCHEMA), help="Path to BAML schema file")
    p.add_argument("--input", help="Read worker output from this file (default: stdin)")
    p.add_argument("--allow-partials", action="store_true", help="Permit incomplete JSON (use when worker may truncate)")
    args = p.parse_args()

    try:
        schema_text = Path(args.schema).read_text()
    except OSError as e:
        print(f"PARSE_ERROR: cannot read schema {args.schema}: {e}", file=sys.stderr)
        return 2

    known = discover_root_classes(schema_text)
    if known and args.root not in known:
        print(
            f"PARSE_ERROR: unknown --root '{args.root}'. Available in {args.schema}: {sorted(known)}",
            file=sys.stderr,
        )
        return 2

    raw = Path(args.input).read_text() if args.input else sys.stdin.read()
    if not raw.strip():
        print("PARSE_ERROR: empty input", file=sys.stderr)
        return 1

    try:
        import baml_lib
        ctx = baml_lib.PyBamlContext(schema_text, args.root)
        result = ctx.validate_result(raw, allow_partials=args.allow_partials)
    except Exception as e:
        print(f"PARSE_ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            pass
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
