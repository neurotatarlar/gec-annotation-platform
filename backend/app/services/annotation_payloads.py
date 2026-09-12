"""
Pure helpers for validating and normalizing annotation payloads.
"""

import re
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


def validate_canonical_annotation_payload(
    payload: dict,
    *,
    start_token: int,
    end_token: int,
    token_count: int,
) -> None:
    """Validate the durable v2 contract used by current editor saves."""
    validate_annotation_payload(payload)
    if payload.get("schema_version") != 2:
        raise AnnotationPayloadError("Canonical saves require payload schema_version 2")
    correction_id = payload.get("client_correction_id")
    if not isinstance(correction_id, str) or not correction_id.strip():
        raise AnnotationPayloadError("Canonical corrections require client_correction_id")

    before_tokens = payload.get("before_tokens") or []
    if len(set(before_tokens)) != len(before_tokens):
        raise AnnotationPayloadError("before_tokens must be unique")
    before_indices: list[int] = []
    for token_id in before_tokens:
        match = re.fullmatch(r"base-(\d+)", str(token_id))
        if not match:
            raise AnnotationPayloadError("Canonical before_tokens must use base-N ids")
        index = int(match.group(1))
        if index >= token_count:
            raise AnnotationPayloadError("before_tokens contains an out-of-range token id")
        before_indices.append(index)

    operation = payload["operation"]
    if operation == "move":
        move_from = payload.get("move_from")
        move_to = payload.get("move_to")
        move_len = payload.get("move_len")
        if not all(isinstance(value, int) for value in (move_from, move_to, move_len)):
            raise AnnotationPayloadError("Canonical moves require move_from, move_to, and move_len")
        if move_len < 1 or move_from < 0 or move_from + move_len > token_count:
            raise AnnotationPayloadError("Canonical move source is out of range")
        if move_to < 0 or move_to > token_count:
            raise AnnotationPayloadError("Canonical move destination is out of range")
        if before_indices != list(range(move_from, move_from + move_len)):
            raise AnnotationPayloadError("Canonical move before_tokens must match move source")
        if start_token != move_to or end_token != move_to + move_len - 1:
            raise AnnotationPayloadError("Canonical move span must match its destination")
    elif operation in {"replace", "delete"}:
        if not before_indices:
            raise AnnotationPayloadError(f"Canonical {operation} requires before_tokens")
        if start_token != min(before_indices) or end_token != max(before_indices):
            raise AnnotationPayloadError(f"Canonical {operation} span must match before_tokens")
    elif operation == "insert":
        if start_token != end_token or start_token < 0 or start_token > token_count:
            raise AnnotationPayloadError("Canonical insert position is out of range")
    elif operation == "noop" and (before_tokens or payload.get("after_tokens")):
        raise AnnotationPayloadError("Canonical noop payload must not contain token edits")


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
