import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.annotation_rendering import apply_annotations, resolve_tokens_snapshot_for_source


FIXTURE_PATH = Path(__file__).parents[2] / "testdata" / "annotation_rendering_cases.json"


def load_cases() -> list[dict]:
    return json.loads(FIXTURE_PATH.read_text())


@pytest.mark.parametrize("case", load_cases(), ids=lambda case: case["name"])
def test_backend_rendering_matches_shared_semantic_tokens(case):
    annotations = [SimpleNamespace(**item) for item in case["annotations"]]
    source_tokens = resolve_tokens_snapshot_for_source(case["source"], annotations)
    target_tokens = apply_annotations(source_tokens, annotations)

    assert [
        token["text"]
        for token in target_tokens
        if token.get("kind") != "empty" and token.get("text")
    ] == case["expected_tokens"]
