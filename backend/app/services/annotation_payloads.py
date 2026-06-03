"""
Pure helpers for validating and normalizing annotation payloads.
"""

from typing import Any

from pydantic import BaseModel


class AnnotationPayloadError(ValueError):
    """Raised when an annotation payload does not match the editor contract."""


def ensure_payload_dict(raw: BaseModel | dict | None) -> dict:
    if isinstance(raw, BaseModel):
        return raw.model_dump()
    return dict(raw or {})


def validate_annotation_payload(payload: dict) -> None:
    op = payload.get("operation")
    if op not in {"replace", "delete", "insert", "move", "noop"}:
        raise AnnotationPayloadError("Invalid operation")

    after_tokens = payload.get("after_tokens", [])
    if not isinstance(after_tokens, list):
        raise AnnotationPayloadError("after_tokens must be a list")
    for token in after_tokens:
        if not isinstance(token, dict):
            raise AnnotationPayloadError("after_tokens must contain objects")
        if "id" not in token or "text" not in token:
            raise AnnotationPayloadError("after_tokens entries must include id and text")
        origin = token.get("origin")
        if origin not in {"base", "inserted"}:
            raise AnnotationPayloadError("after_tokens origin must be 'base' or 'inserted'")

    before_tokens = payload.get("before_tokens", [])
    if not isinstance(before_tokens, list):
        raise AnnotationPayloadError("before_tokens must be a list")


def normalize_token_fragment(token: object) -> tuple:
    if isinstance(token, dict):
        return (
            str(token.get("id")) if token.get("id") is not None else None,
            str(token.get("text") or ""),
            token.get("origin"),
            token.get("space_before", token.get("spaceBefore")),
            token.get("source_id", token.get("sourceId")),
        )
    return (
        str(getattr(token, "id", None)) if getattr(token, "id", None) is not None else None,
        str(getattr(token, "text", "") or ""),
        getattr(token, "origin", None),
        getattr(token, "space_before", getattr(token, "spaceBefore", None)),
        getattr(token, "source_id", getattr(token, "sourceId", None)),
    )


def payload_signature(payload: dict, replacement: str | None) -> tuple:
    op = payload.get("operation") or ("replace" if replacement else "noop")
    before_tokens = payload.get("before_tokens")
    if not isinstance(before_tokens, list):
        before_tokens = []
    after_tokens = payload.get("after_tokens")
    if not isinstance(after_tokens, list):
        after_tokens = []
    move_from = payload.get("move_from", payload.get("moveFrom"))
    move_to = payload.get("move_to", payload.get("moveTo"))
    move_len = payload.get("move_len", payload.get("moveLen"))
    return (
        op,
        tuple(str(tok) for tok in before_tokens),
        tuple(normalize_token_fragment(tok) for tok in after_tokens),
        move_from,
        move_to,
        move_len,
    )


def derive_replacement(replacement: str | None, payload: dict) -> str | None:
    resolved = replacement
    if resolved is None:
        after_tokens = payload.get("after_tokens")
        if isinstance(after_tokens, list):
            texts: list[str] = []
            for token in after_tokens:
                if isinstance(token, dict):
                    texts.append(str(token.get("text", "") or ""))
                else:
                    text_attr = getattr(token, "text", "")
                    texts.append(str(text_attr or ""))
            candidate = " ".join(texts).strip()
            resolved = candidate or None
    if payload.get("operation") == "noop":
        resolved = resolved or None
    return resolved


def summarize_annotations(items: list[Any]) -> list[dict[str, object]]:
    summary = []
    for ann in items[:5]:
        payload = getattr(ann, "payload", None)
        op = None
        before = None
        after = None
        text_hash = None
        if isinstance(payload, BaseModel):
            payload = payload.model_dump()
        if isinstance(payload, dict):
            op = payload.get("operation")
            before = len(payload.get("before_tokens") or [])
            after_tokens = payload.get("after_tokens") or []
            after = len(after_tokens)
            text_hash = payload.get("text_sha256") or payload.get("text_hash")
        summary.append(
            {
                "start": getattr(ann, "start_token", None),
                "end": getattr(ann, "end_token", None),
                "op": op,
                "before_len": before,
                "after_len": after,
                "hash": text_hash,
                "has_id": getattr(ann, "id", None) is not None,
            }
        )
    return summary
