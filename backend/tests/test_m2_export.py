from types import SimpleNamespace

import pytest

from app.services.annotation_saves import sha256_text, sha256_tokens
from app.services.m2_export import (
    AlignedEdit,
    M2ExportError,
    align_tokens,
    build_m2_block,
    build_m2_export,
    parse_and_apply_m2_block,
)


def annotation(
    source: str,
    tokens: list[str],
    ann_id: int,
    start: int,
    end: int,
    operation: str,
    label: str,
    *,
    replacement: str | None = None,
    before_tokens: list[str] | None = None,
    after_tokens: list[dict] | None = None,
    **payload_extra,
):
    return SimpleNamespace(
        id=ann_id,
        start_token=start,
        end_token=end,
        replacement=replacement,
        error_type=SimpleNamespace(en_name=label),
        payload={
            "operation": operation,
            "before_tokens": before_tokens or [],
            "after_tokens": after_tokens or [],
            "text_sha256": sha256_text(source),
            "text_tokens": tokens,
            "text_tokens_sha256": sha256_tokens(tokens),
            **payload_extra,
        },
    )


def text(source: str, text_id: int = 1):
    return SimpleNamespace(id=text_id, content=source)


def test_align_tokens_is_deterministic_and_non_overlapping():
    edits = align_tokens(["a", "b", "c"], ["a", "x", "new", "c"])

    assert edits == [AlignedEdit(source_start=1, source_end=2, target_start=1, target_end=3)]


def test_build_m2_block_round_trips_replace_delete_and_insert():
    source = "alpha beta gamma"
    tokens = ["alpha", "beta", "gamma"]
    annotations = [
        annotation(
            source,
            tokens,
            1,
            0,
            0,
            "replace",
            "Spelling",
            replacement="ALPHA",
            before_tokens=["base-0"],
            after_tokens=[{"id": "base-0", "text": "ALPHA", "origin": "base"}],
        ),
        annotation(source, tokens, 2, 1, 1, "delete", "Deletion", before_tokens=["base-1"]),
        annotation(
            source,
            tokens,
            3,
            2,
            1,
            "insert",
            "Insertion",
            replacement="new",
            after_tokens=[{"id": "new", "text": "new", "origin": "inserted"}],
        ),
    ]

    result = build_m2_block(text(source), annotations)
    parsed_source, parsed_target = parse_and_apply_m2_block(result.block)

    assert parsed_source == tokens
    assert parsed_target == ["ALPHA", "new", "gamma"]
    assert result.edit_count > 0


def test_build_m2_block_uses_edited_move_fragments():
    source = "alpha beta gamma delta epsilon"
    tokens = source.split()
    move = annotation(
        source,
        tokens,
        1,
        0,
        1,
        "move",
        "WordOrder",
        replacement="DELTA",
        before_tokens=["base-2", "base-3"],
        after_tokens=[{"id": "edited", "text": "DELTA", "origin": "base"}],
        move_from=2,
        move_to=0,
        move_len=2,
    )

    result = build_m2_block(text(source), [move])
    _, target = parse_and_apply_m2_block(result.block)

    assert target == ["DELTA", "alpha", "beta", "epsilon"]
    assert "WordOrder" in result.block


def test_build_m2_block_uses_other_for_merged_different_labels():
    source = "alpha beta"
    tokens = source.split()
    annotations = [
        annotation(
            source,
            tokens,
            1,
            0,
            0,
            "replace",
            "Spelling",
            replacement="ALPHA",
            before_tokens=["base-0"],
            after_tokens=[{"id": "base-0", "text": "ALPHA", "origin": "base"}],
        ),
        annotation(
            source,
            tokens,
            2,
            1,
            0,
            "insert",
            "Punctuation",
            replacement="new",
            after_tokens=[{"id": "new", "text": "new", "origin": "inserted"}],
        ),
    ]

    result = build_m2_block(text(source), annotations)

    assert result.other_count == 1
    assert result.ambiguous_label_count == 1
    assert "|||OTHER|||" in result.block


def test_build_m2_block_reports_unattributed_repeated_token_alignment():
    source = ". ."
    tokens = source.split()
    insertion = annotation(
        source,
        tokens,
        1,
        2,
        1,
        "insert",
        "Punctuation",
        replacement=".",
        after_tokens=[{"id": "new", "text": ".", "origin": "inserted"}],
    )

    result = build_m2_block(text(source), [insertion])

    assert result.unattributed_label_count == 1
    assert result.label_issues[0].candidate_labels == ()
    assert "|||OTHER|||" in result.block


def test_build_m2_block_emits_noop_for_unchanged_text():
    result = build_m2_block(text("already correct"), [])

    assert result.noop is True
    assert "A -1 -1|||noop|||-NONE-|||REQUIRED|||-NONE-|||0" in result.block


def test_build_m2_block_expands_internal_whitespace_tokens():
    source = "Call +7 905 023-52-54 now"
    tokens = ["Call", "+7 905 023-52-54", "now"]
    noop = annotation(source, tokens, 1, -1, -1, "noop", "noop")

    result = build_m2_block(text(source), [noop])

    assert result.source_tokens == ("Call", "+7", "905", "023-52-54", "now")


def test_build_m2_block_rejects_invalid_snapshot_hash():
    source = "alpha beta"
    ann = annotation(source, source.split(), 1, 0, 0, "delete", "Deletion")
    ann.payload["text_tokens_sha256"] = "wrong"

    with pytest.raises(M2ExportError, match="token snapshot hash"):
        build_m2_block(text(source, 42), [ann])


def test_build_m2_block_rejects_reserved_delimiter():
    with pytest.raises(M2ExportError, match="reserved M2 delimiter"):
        build_m2_block(text("bad ||| source"), [])


def test_build_m2_export_reports_audit_counts():
    source = "plain sample"
    result = build_m2_export([(text(source), [])])

    assert result.audit.selected_texts == 1
    assert result.audit.noop_texts == 1
    assert result.audit.unattributed_label_edits == 0
    assert result.content.endswith("\n")
