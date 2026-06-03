from pydantic import BaseModel

from app.services.annotation_payloads import (
    AnnotationPayloadError,
    derive_replacement,
    ensure_payload_dict,
    payload_signature,
    summarize_annotations,
    validate_annotation_payload,
)


class PayloadModel(BaseModel):
    operation: str = "replace"
    before_tokens: list[str] = []
    after_tokens: list[dict] = []


class AnnotationLike:
    def __init__(self, payload, start_token=0, end_token=0, ann_id=None):
        self.payload = payload
        self.start_token = start_token
        self.end_token = end_token
        self.id = ann_id


def test_ensure_payload_dict_accepts_model_dict_and_none():
    assert ensure_payload_dict(PayloadModel(before_tokens=["base-0"]))["before_tokens"] == ["base-0"]
    assert ensure_payload_dict({"operation": "delete"}) == {"operation": "delete"}
    assert ensure_payload_dict(None) == {}


def test_validate_annotation_payload_accepts_editor_contract():
    validate_annotation_payload(
        {
            "operation": "replace",
            "before_tokens": ["base-0"],
            "after_tokens": [{"id": "base-0", "text": "hi", "origin": "base"}],
        }
    )


def test_validate_annotation_payload_rejects_invalid_shapes():
    invalid_payloads = [
        ({"operation": "bad", "before_tokens": [], "after_tokens": []}, "Invalid operation"),
        ({"operation": "replace", "before_tokens": [], "after_tokens": "x"}, "after_tokens must be a list"),
        ({"operation": "replace", "before_tokens": [], "after_tokens": ["x"]}, "after_tokens must contain objects"),
        (
            {"operation": "replace", "before_tokens": [], "after_tokens": [{"id": "x", "origin": "base"}]},
            "after_tokens entries must include id and text",
        ),
        (
            {"operation": "replace", "before_tokens": [], "after_tokens": [{"id": "x", "text": "x", "origin": "bad"}]},
            "after_tokens origin must be 'base' or 'inserted'",
        ),
        (
            {"operation": "replace", "before_tokens": "x", "after_tokens": []},
            "before_tokens must be a list",
        ),
    ]
    for payload, message in invalid_payloads:
        try:
            validate_annotation_payload(payload)
        except AnnotationPayloadError as exc:
            assert str(exc) == message
        else:
            raise AssertionError(f"Expected validation failure for {payload}")


def test_payload_signature_normalizes_tokens_and_move_aliases():
    payload = {
        "operation": "move",
        "before_tokens": ["base-2"],
        "after_tokens": [
            {
                "id": "base-2",
                "text": "gamma",
                "origin": "base",
                "spaceBefore": True,
                "sourceId": "base-2",
            }
        ],
        "moveFrom": 2,
        "moveTo": 0,
        "moveLen": 1,
    }

    assert payload_signature(payload, None) == (
        "move",
        ("base-2",),
        (("base-2", "gamma", "base", True, "base-2"),),
        2,
        0,
        1,
    )


def test_derive_replacement_uses_after_tokens_when_missing_and_keeps_noop_empty():
    assert derive_replacement(
        None,
        {
            "operation": "replace",
            "after_tokens": [
                {"id": "a", "text": "hello", "origin": "base"},
                {"id": "b", "text": "world", "origin": "inserted"},
            ],
        },
    ) == "hello world"
    assert derive_replacement("explicit", {"operation": "replace", "after_tokens": []}) == "explicit"
    assert derive_replacement(None, {"operation": "noop", "after_tokens": []}) is None


def test_summarize_annotations_handles_models_and_hashes():
    summary = summarize_annotations(
        [
            AnnotationLike(
                PayloadModel(
                    operation="replace",
                    before_tokens=["base-0"],
                    after_tokens=[{"id": "base-0", "text": "hi", "origin": "base"}],
                ),
                start_token=0,
                end_token=0,
                ann_id=10,
            ),
            AnnotationLike(
                {
                    "operation": "delete",
                    "before_tokens": ["base-1"],
                    "after_tokens": [],
                    "text_sha256": "abc",
                },
                start_token=1,
                end_token=1,
            ),
        ]
    )

    assert summary[0]["op"] == "replace"
    assert summary[0]["before_len"] == 1
    assert summary[0]["after_len"] == 1
    assert summary[0]["has_id"] is True
    assert summary[1]["op"] == "delete"
    assert summary[1]["hash"] == "abc"
