"""Admin-only APIs for reviewing isolated annotation repair proposals."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..models import AnnotationRepairBatch, AnnotationRepairItem, User
from ..services.annotation_repairs import (
    AnnotationRepairError,
    build_approved_manifest,
    build_review_state,
    revise_repair_proposal,
)
from ..services.auth import get_db, require_admin

router = APIRouter(prefix="/api/repairs", tags=["annotation-repairs"])


class RepairDecisionRequest(BaseModel):
    status: Literal["pending", "approved", "wrong"]
    note: str | None = None
    candidate_hash: str
    uncertainty_acknowledged: bool = False


class RepairProposalRequest(BaseModel):
    candidate_hash: str
    proposed_target: str | None = None
    labels: dict[str, int] | None = None
    restore_revision: int | None = None


def serialize_item(item: AnnotationRepairItem, *, include_annotations: bool = True) -> dict:
    payload = {
        "id": item.id,
        "batch_id": item.batch_id,
        "text_id": item.text_id,
        "task_id": item.task_id,
        "author_id": str(item.author_id),
        "source": item.source_text,
        "current_target": item.current_target,
        "restored_target": item.restored_target,
        "proposed_target": item.proposed_target,
        "recovery_evidence": item.recovery_evidence,
        "uncertainty_acknowledged": item.uncertainty_acknowledged,
        "original_fingerprint": item.original_fingerprint,
        "candidate_hash": item.candidate_hash,
        "confidence": item.confidence,
        "risk": item.risk,
        "explanation": item.explanation,
        "status": item.status,
        "note": item.note,
        "reviewed_at": item.reviewed_at.isoformat() if item.reviewed_at else None,
        "proposal_revision": item.proposal_revision,
    }
    if include_annotations:
        payload["proposed_annotations"] = item.proposed_annotations
    return payload


@router.get("/batches")
def list_batches(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    batches = (
        db.query(AnnotationRepairBatch)
        .filter(AnnotationRepairBatch.status != "superseded")
        .order_by(AnnotationRepairBatch.created_at.desc())
        .all()
    )
    result = []
    for batch in batches:
        counts = dict(
            db.query(AnnotationRepairItem.status, func.count(AnnotationRepairItem.id))
            .filter(AnnotationRepairItem.batch_id == batch.id)
            .group_by(AnnotationRepairItem.status)
            .all()
        )
        result.append(
            {
                "id": batch.id,
                "category_id": batch.category_id,
                "revision": batch.revision,
                "source_snapshot_hash": batch.source_snapshot_hash,
                "status": batch.status,
                "item_count": batch.item_count,
                "counts": {key: int(counts.get(key, 0)) for key in ("pending", "approved", "wrong")},
                "created_at": batch.created_at.isoformat() if batch.created_at else None,
            }
        )
    return result


@router.get("/batches/{batch_id}/items")
def list_repair_items(
    batch_id: str,
    status: Literal["pending", "approved", "wrong"] | None = None,
    confidence: Literal["high", "medium", "low"] | None = None,
    query: str | None = Query(None),
    limit: int = Query(50, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    if not db.get(AnnotationRepairBatch, batch_id):
        raise HTTPException(status_code=404, detail="Repair batch not found")
    base = db.query(AnnotationRepairItem).filter(AnnotationRepairItem.batch_id == batch_id)
    if status:
        base = base.filter(AnnotationRepairItem.status == status)
    if confidence:
        base = base.filter(AnnotationRepairItem.confidence == confidence)
    if query:
        clauses = [AnnotationRepairItem.source_text.ilike(f"%{query}%")]
        if query.isdigit():
            clauses.append(AnnotationRepairItem.text_id == int(query))
        base = base.filter(or_(*clauses))
    total = base.count()
    items = base.order_by(AnnotationRepairItem.text_id).offset(offset).limit(limit).all()
    return {
        "items": [serialize_item(item) for item in items],
        "total": total,
        "next_offset": offset + len(items) if offset + len(items) < total else None,
    }


@router.get("/items/{item_id}")
def get_repair_item(
    item_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    item = db.get(AnnotationRepairItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Repair item not found")
    return serialize_item(item)


@router.patch("/items/{item_id}")
def review_repair_item(
    item_id: int,
    request: RepairDecisionRequest,
    db: Session = Depends(get_db),
    reviewer: User = Depends(require_admin),
):
    item = db.get(AnnotationRepairItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Repair item not found")
    if request.candidate_hash != item.candidate_hash:
        raise HTTPException(status_code=409, detail="Repair proposal changed; reload before reviewing")
    note = (request.note or "").strip()
    if request.status == "wrong" and not note:
        raise HTTPException(status_code=422, detail="A note is required when marking a proposal wrong")
    if request.status == "approved" and any(
        annotation.get("error_type_id") is None
        or (annotation.get("payload") or {}).get("label_needs_review") is True
        for annotation in item.proposed_annotations
    ):
        raise HTTPException(
            status_code=422,
            detail="Every proposed correction must have a confirmed error label",
        )
    if (
        request.status == "approved"
        and item.recovery_evidence.get("possible_deleted_rows")
        and not request.uncertainty_acknowledged
    ):
        raise HTTPException(
            status_code=422,
            detail="Acknowledge the incomplete post-submission history before approval",
        )
    item.status = request.status
    item.uncertainty_acknowledged = (
        request.uncertainty_acknowledged if request.status == "approved" else False
    )
    item.note = note or None
    item.reviewed_by_id = reviewer.id
    item.reviewed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(item)
    return serialize_item(item)


@router.patch("/items/{item_id}/proposal")
def update_repair_proposal(
    item_id: int,
    request: RepairProposalRequest,
    db: Session = Depends(get_db),
    reviewer: User = Depends(require_admin),
):
    item = db.get(AnnotationRepairItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Repair item not found")
    if request.candidate_hash != item.candidate_hash:
        raise HTTPException(status_code=409, detail="Repair proposal changed; reload before editing")
    try:
        updated = revise_repair_proposal(
            db,
            item,
            reviewer.id,
            proposed_target=request.proposed_target,
            labels=request.labels,
            restore_revision=request.restore_revision,
        )
    except AnnotationRepairError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return serialize_item(updated)


@router.get("/batches/{batch_id}/manifest")
def get_approved_manifest(
    batch_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    try:
        return build_approved_manifest(db, batch_id)
    except AnnotationRepairError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/batches/{batch_id}/review-state")
def get_review_state(
    batch_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    try:
        return build_review_state(db, batch_id)
    except AnnotationRepairError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
