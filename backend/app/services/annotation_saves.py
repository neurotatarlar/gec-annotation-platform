"""
Database workflow for saving annotation drafts.
"""

import hashlib
from typing import Any

from sqlalchemy.orm import Session

from ..models import Annotation, AnnotationVersion, TextSample
from ..schemas.common import AnnotationSaveRequest
from .annotation_payloads import (
    AnnotationPayloadError,
    derive_replacement,
    ensure_payload_dict,
    payload_signature,
    validate_annotation_payload,
)


class AnnotationSaveError(ValueError):
    """Raised when an annotation save request violates the save contract."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_tokens(tokens: list[str]) -> str:
    joined = "\u241f".join(tokens)  # unit separator to minimize collision with token text
    return sha256_text(joined)


def annotation_matches(
    candidate: Annotation,
    expected_sig: tuple,
    expected_replacement: str | None,
    expected_error_type: int | None,
) -> bool:
    if (candidate.replacement or None) != (expected_replacement or None):
        return False
    if candidate.error_type_id != expected_error_type:
        return False
    candidate_payload = ensure_payload_dict(candidate.payload)
    candidate_sig = payload_signature(candidate_payload, candidate.replacement)
    return candidate_sig == expected_sig


def ensure_payload_text_identity(payload: dict, text: TextSample) -> None:
    text_content = text.content or ""
    text_hash = sha256_text(text_content)
    payload_hash = payload.get("text_sha256")
    if payload_hash and payload_hash != text_hash:
        raise AnnotationSaveError(
            409,
            "Client text hash does not match server text. Reload the text before saving.",
        )
    payload["text_sha256"] = payload_hash or text_hash
    if (
        "text_tokens" not in payload
        or not isinstance(payload.get("text_tokens"), list)
        or len(payload.get("text_tokens") or []) == 0
    ):
        tokens_snapshot = text_content.split()
        payload["text_tokens"] = tokens_snapshot
        payload["text_tokens_sha256"] = sha256_tokens(tokens_snapshot)
    elif not payload.get("text_tokens_sha256"):
        payload["text_tokens_sha256"] = sha256_tokens([str(t) for t in payload["text_tokens"]])


def save_annotation_drafts(
    db: Session,
    text: TextSample,
    author_id: Any,
    request: AnnotationSaveRequest,
) -> list[Annotation]:
    existing = (
        db.query(Annotation)
        .filter(Annotation.text_id == text.id, Annotation.author_id == author_id)
        .all()
    )
    server_version = max((ann.version for ann in existing), default=0)
    client_version = request.client_version or 0
    if client_version and client_version < server_version:
        raise AnnotationSaveError(
            409,
            "Client version is stale. Reload annotations before saving.",
        )

    saved: list[Annotation] = []
    deleted_ids = set(request.deleted_ids or [])
    if deleted_ids:
        (
            db.query(Annotation)
            .filter(
                Annotation.text_id == text.id,
                Annotation.id.in_(deleted_ids),
            )
            .delete(synchronize_session=False)
        )
        existing = [ann for ann in existing if ann.id not in deleted_ids]

    if deleted_ids:
        existing = (
            db.query(Annotation)
            .filter(Annotation.text_id == text.id, Annotation.author_id == author_id)
            .all()
        )
    existing_by_id = {annotation.id: annotation for annotation in existing}
    existing_by_span = {(annotation.start_token, annotation.end_token): annotation for annotation in existing}
    other_existing = (
        db.query(Annotation)
        .filter(Annotation.text_id == text.id, Annotation.author_id != author_id)
        .all()
    )
    other_by_id = {annotation.id: annotation for annotation in other_existing}
    other_by_span: dict[tuple[int, int], list[Annotation]] = {}
    for annotation in other_existing:
        other_by_span.setdefault((annotation.start_token, annotation.end_token), []).append(annotation)
    for group in other_by_span.values():
        group.sort(key=lambda ann: ann.id)

    for item in request.annotations:
        if item.id and item.id in deleted_ids:
            continue
        payload = ensure_payload_dict(item.payload)
        try:
            validate_annotation_payload(payload)
        except AnnotationPayloadError as exc:
            raise AnnotationSaveError(400, str(exc)) from exc

        ensure_payload_text_identity(payload, text)
        replacement = derive_replacement(item.replacement, payload)

        annotation = None
        if item.id:
            annotation = existing_by_id.get(item.id)
        if not annotation:
            annotation = existing_by_span.get((item.start_token, item.end_token))

        if annotation:
            annotation.start_token = item.start_token
            annotation.end_token = item.end_token
            annotation.replacement = replacement
            annotation.payload = payload
            annotation.error_type_id = item.error_type_id
            annotation.version += 1
            saved.append(annotation)
            continue

        payload_sig = payload_signature(payload, replacement)
        other_annotation = other_by_id.get(item.id) if item.id else None
        if not other_annotation:
            candidates = other_by_span.get((item.start_token, item.end_token), [])
            if candidates:
                match = next(
                    (
                        candidate
                        for candidate in candidates
                        if annotation_matches(candidate, payload_sig, replacement, item.error_type_id)
                    ),
                    None,
                )
                if match:
                    continue
                other_annotation = candidates[0]
        if other_annotation:
            if annotation_matches(other_annotation, payload_sig, replacement, item.error_type_id):
                continue
            other_annotation.author_id = author_id
            other_annotation.start_token = item.start_token
            other_annotation.end_token = item.end_token
            other_annotation.replacement = replacement
            other_annotation.payload = payload
            other_annotation.error_type_id = item.error_type_id
            other_annotation.version += 1
            annotation = other_annotation
            existing_by_id[annotation.id] = annotation
            existing_by_span[(annotation.start_token, annotation.end_token)] = annotation
        else:
            annotation = Annotation(
                text_id=text.id,
                author_id=author_id,
                start_token=item.start_token,
                end_token=item.end_token,
                replacement=replacement,
                payload=payload,
                error_type_id=item.error_type_id,
            )
            db.add(annotation)
        saved.append(annotation)

    db.flush()
    for ann in saved:
        db.add(
            AnnotationVersion(
                annotation_id=ann.id,
                version=ann.version,
                snapshot={
                    "start_token": ann.start_token,
                    "end_token": ann.end_token,
                    "replacement": ann.replacement,
                    "payload": ann.payload,
                    "error_type_id": ann.error_type_id,
                },
            )
        )

    db.commit()
    return saved
