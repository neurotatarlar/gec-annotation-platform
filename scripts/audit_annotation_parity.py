#!/usr/bin/env python3
"""Compare frontend hydration projections with backend annotation rendering."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.services.annotation_rendering import (  # noqa: E402
    apply_annotations,
    resolve_tokens_snapshot_for_source,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Production annotation fixture JSON")
    parser.add_argument("frontend_output", type=Path, help="Frontend semantic-token JSON")
    parser.add_argument("report", type=Path, help="Audit report destination")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    records = json.loads(args.input.read_text())
    frontend_rows = json.loads(args.frontend_output.read_text())
    frontend_by_id = {row["id"]: row["target_tokens"] for row in frontend_rows}
    mismatches: list[dict[str, object]] = []

    for record in records:
        annotations = [SimpleNamespace(**annotation) for annotation in record["annotations"]]
        source_tokens = resolve_tokens_snapshot_for_source(record["source"], annotations)
        backend_tokens = [
            str(token.get("text") or "")
            for token in apply_annotations(source_tokens, annotations)
            if token.get("kind") != "empty" and token.get("text")
        ]
        frontend_tokens = frontend_by_id.get(record["id"])
        if backend_tokens != frontend_tokens:
            mismatches.append(
                {
                    "id": record["id"],
                    "backend_tokens": backend_tokens,
                    "frontend_tokens": frontend_tokens,
                }
            )

    report = {
        "selected_texts": len(records),
        "frontend_projected_texts": len(frontend_rows),
        "mismatch_count": len(mismatches),
        "mismatches": mismatches,
    }
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key != "mismatches"}))
    if mismatches:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
