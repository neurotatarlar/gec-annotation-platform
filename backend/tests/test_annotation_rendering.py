from types import SimpleNamespace

from app.services.annotation_rendering import (
    annotation_to_edit,
    build_export_record,
    render_corrected_text,
    tokenize_to_tokens,
)


def ann(
    start: int,
    end: int,
    operation: str,
    after_tokens: list[dict] | None = None,
    replacement: str | None = None,
    **payload_extra,
) -> SimpleNamespace:
    payload = {
        "operation": operation,
        "text_tokens": ["alpha", "beta", "gamma"],
        "after_tokens": after_tokens or [],
        **payload_extra,
    }
    return SimpleNamespace(
        id=payload_extra.get("id", 1),
        start_token=start,
        end_token=end,
        replacement=replacement,
        payload=payload,
        error_type=SimpleNamespace(en_name="ERR"),
    )


def test_tokenize_preserves_punctuation_spacing_contract():
    tokens = tokenize_to_tokens("Hello, world!")

    assert tokens == [
        {"text": "Hello", "kind": "word", "space_before": False},
        {"text": ",", "kind": "punct", "space_before": False},
        {"text": "world", "kind": "word", "space_before": True},
        {"text": "!", "kind": "punct", "space_before": False},
    ]


def test_render_corrected_text_preserves_punctuation_without_extra_space():
    rendered = render_corrected_text(
        "Hello, world!",
        [
            SimpleNamespace(
                id=1,
                start_token=2,
                end_token=2,
                replacement=None,
                payload={
                    "operation": "replace",
                    "text_tokens": ["Hello", ",", "world", "!"],
                    "after_tokens": [{"id": "a1", "text": "there", "origin": "base"}],
                },
            )
        ],
    )

    assert rendered == "Hello, there!"


def test_render_corrected_text_honors_explicit_space_before_punctuation():
    rendered = render_corrected_text(
        "foo, bar",
        [
            SimpleNamespace(
                id=1,
                start_token=1,
                end_token=1,
                replacement=None,
                payload={
                    "operation": "replace",
                    "text_tokens": ["foo", ",", "bar"],
                    "after_tokens": [{"id": "comma", "text": ",", "origin": "base", "space_before": True}],
                },
            )
        ],
    )

    assert rendered == "foo , bar"


def test_render_corrected_text_honors_explicit_no_space_before_word():
    rendered = render_corrected_text(
        "foo , bar",
        [
            SimpleNamespace(
                id=1,
                start_token=2,
                end_token=2,
                replacement=None,
                payload={
                    "operation": "replace",
                    "text_tokens": ["foo", ",", "bar"],
                    "after_tokens": [{"id": "bar", "text": "bar", "origin": "base", "space_before": False}],
                },
            )
        ],
    )

    assert rendered == "foo ,bar"


def test_render_corrected_text_keeps_source_line_breaks():
    rendered = render_corrected_text(
        "alpha beta\ngamma",
        [
            SimpleNamespace(
                id=1,
                start_token=1,
                end_token=1,
                replacement=None,
                payload={
                    "operation": "replace",
                    "text_tokens": ["alpha", "beta", "gamma"],
                    "after_tokens": [{"id": "a1", "text": "BETA", "origin": "base"}],
                },
            )
        ],
    )

    assert rendered == "alpha BETA\ngamma"


def test_annotation_to_edit_normalizes_label_and_move_fields():
    edit = annotation_to_edit(
        ann(
            2,
            2,
            "move",
            [{"id": "m1", "text": "gamma", "origin": "base"}],
            move_from=2,
            move_to=0,
            move_len=1,
        )
    )

    assert edit == {
        "start_token": 2,
        "end_token": 2,
        "operation": "move",
        "error_type": "ERR",
        "replacement": None,
        "move_from": 2,
        "move_to": 0,
        "move_len": 1,
    }


def test_build_export_record_renders_target_and_sorted_edits():
    text = SimpleNamespace(id=42, content="alpha beta gamma")
    first = ann(1, 1, "delete", [])
    second = ann(0, 0, "replace", [{"id": "a1", "text": "ALPHA", "origin": "base"}])

    record = build_export_record(text, [first, second])

    assert record["id"] == 42
    assert record["source"] == "alpha beta gamma"
    assert record["target"] == "ALPHA gamma"
    assert [edit["start_token"] for edit in record["edits"]] == [0, 1]
