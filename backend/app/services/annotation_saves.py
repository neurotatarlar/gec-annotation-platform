"""
Database workflow for saving annotation drafts.
"""

import hashlib
from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from ..models import Annotation, AnnotationVersion, TextSample
from ..schemas.common import AnnotationSaveRequest
from .annotation_payloads import (
    AnnotationPayloadError,
    derive_replacement,
    ensure_payload_dict,
    validate_canonical_annotation_payload,
    validate_annotation_payload,
)
from .annotation_rendering import render_corrected_text


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


def _save_annotation_drafts(
    db: Session,
    text: TextSample,
    author_id: Any,
    request: AnnotationSaveRequest,
) -> list[Annotation]:
    # Serialize saves for this source, including first saves where no annotation rows exist.
    db.query(TextSample).filter(
        TextSample.id == text.id
    ).populate_existing().with_for_update().one()
    requested_target = (
        render_corrected_text(text.content or "", request.annotations)
        if request.schema_version == 2
        else None
    )
    if request.schema_version == 2 and (
        request.expected_target is not None or request.expected_target_sha256
    ):
        rendered_target = render_corrected_text(text.content or "", request.annotations)
        target_differs = (
            request.expected_target is not None and rendered_target != request.expected_target
        )
        hash_differs = (
            request.expected_target_sha256 is not None
            and sha256_text(rendered_target) != request.expected_target_sha256
        )
        if target_differs or hash_differs:
            raise AnnotationSaveError(
                409,
                "Client and server corrected text differ. Reload the text before saving.",
            )

    existing = (
        db.query(Annotation)
        .filter(Annotation.text_id == text.id, Annotation.author_id == author_id)
        .all()
    )
    server_version = max((ann.version for ann in existing), default=0)
    client_version = request.client_version or 0
    if (request.schema_version == 2 and existing and client_version != server_version) or (
        request.schema_version != 2 and client_version and client_version < server_version
    ):
        raise AnnotationSaveError(
            409,
            "Client version is stale. Reload annotations before saving.",
        )
    # Empty drafts have no row carrying a revision. Preserve the browser's revision
    # after clearing a draft so subsequent edits can continue without a reload.
    if request.schema_version == 2 and not existing:
        server_version = max(server_version, client_version)

    saved: list[Annotation] = []
    deleted_ids = set(request.deleted_ids or [])
    if deleted_ids:
        (
            db.query(Annotation)
            .filter(
                Annotation.text_id == text.id,
                Annotation.author_id == author_id,
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
    existing_by_span = {
        (annotation.start_token, annotation.end_token): annotation for annotation in existing
    }
    existing_by_client_id = {
        str((annotation.payload or {}).get("client_correction_id")): annotation
        for annotation in existing
        if (annotation.payload or {}).get("client_correction_id")
    }
    if request.schema_version == 2:
        identities = [(a.payload or {}).get("client_correction_id") for a in existing]
        identities = [cid for cid in identities if cid]
        if len(identities) != len(set(identities)):
            raise AnnotationSaveError(409, "Persisted correction identities are duplicated")
    seen_client_ids: set[str] = set()
    expected_rows: dict[str, dict] = {}

    for item in request.annotations:
        if request.schema_version != 2 and item.id and item.id in deleted_ids:
            continue
        payload = ensure_payload_dict(item.payload)
        try:
            validate_annotation_payload(payload)
            if request.schema_version == 2:
                validate_canonical_annotation_payload(
                    payload,
                    start_token=item.start_token,
                    end_token=item.end_token,
                    token_count=len(payload.get("text_tokens") or []),
                )
        except AnnotationPayloadError as exc:
            raise AnnotationSaveError(400, str(exc)) from exc

        ensure_payload_text_identity(payload, text)
        replacement = derive_replacement(item.replacement, payload)

        annotation = None
        client_correction_id = payload.get("client_correction_id")
        if client_correction_id:
            if client_correction_id in seen_client_ids:
                raise AnnotationSaveError(400, "Duplicate client_correction_id in save request")
            seen_client_ids.add(client_correction_id)
        if request.schema_version == 2:
            annotation = existing_by_client_id.get(client_correction_id)
            # Explicit ids may upgrade a legacy row, but cannot rename another v2 correction.
            legacy = existing_by_id.get(item.id) if item.id else None
            if not annotation and legacy and not (legacy.payload or {}).get("client_correction_id"):
                if legacy in saved:
                    raise AnnotationSaveError(409, "A legacy correction was referenced twice")
                annotation = legacy
            expected_rows[client_correction_id] = deepcopy(
                {
                    "start_token": item.start_token,
                    "end_token": item.end_token,
                    "replacement": replacement,
                    "payload": payload,
                    "error_type_id": item.error_type_id,
                }
            )
        else:
            annotation = existing_by_id.get(item.id) if item.id else None
            if not annotation and client_correction_id:
                annotation = existing_by_client_id.get(client_correction_id)
            if not annotation:
                annotation = existing_by_span.get((item.start_token, item.end_token))

        if annotation:
            annotation.start_token = item.start_token
            annotation.end_token = item.end_token
            annotation.replacement = replacement
            annotation.payload = payload
            annotation.error_type_id = item.error_type_id
            annotation.version = (
                server_version + 1 if request.schema_version == 2 else annotation.version + 1
            )
            saved.append(annotation)
            continue

        annotation = Annotation(
            text_id=text.id,
            author_id=author_id,
            start_token=item.start_token,
            end_token=item.end_token,
            replacement=replacement,
            payload=payload,
            error_type_id=item.error_type_id,
            version=server_version + 1 if request.schema_version == 2 else 1,
        )
        db.add(annotation)
        saved.append(annotation)

    if request.schema_version == 2 and request.replace_existing:
        retained_ids = {annotation.id for annotation in saved if annotation.id is not None}
        for annotation in existing:
            if annotation.id not in retained_ids and annotation not in saved:
                db.delete(annotation)

    db.flush()
    if request.schema_version == 2:
        persisted = (
            db.query(Annotation)
            .filter(Annotation.text_id == text.id, Annotation.author_id == author_id)
            .populate_existing()
            .all()
        )
        relevant = (
            persisted
            if request.replace_existing
            else [a for a in persisted if a.id in {x.id for x in saved}]
        )
        actual_rows = {}
        for row in relevant:
            cid = (row.payload or {}).get("client_correction_id")
            if cid in actual_rows:
                raise AnnotationSaveError(409, "Persisted correction identities are duplicated")
            actual_rows[cid] = {
                key: getattr(row, key)
                for key in ("start_token", "end_token", "replacement", "payload", "error_type_id")
            }
        if actual_rows != expected_rows:
            raise AnnotationSaveError(409, "Persisted corrections differ from the save request")
        target_rows = (
            persisted
            if request.replace_existing
            or request.expected_target is not None
            or request.expected_target_sha256
            else relevant
        )
        actual_target = render_corrected_text(text.content or "", target_rows)
        if actual_target != requested_target:
            raise AnnotationSaveError(409, "Persisted corrected text differs from the save request")
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


def save_annotation_drafts(
    db: Session, text: TextSample, author_id: Any, request: AnnotationSaveRequest
) -> list[Annotation]:
    """Save atomically; validation failures must never leave a partial draft."""
    try:
        return _save_annotation_drafts(db, text, author_id, request)
    except Exception:
        db.rollback()
        raise
