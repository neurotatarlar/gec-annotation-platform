from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from ..models import Category, TextSample
from ..schemas.common import CategoryCreate, CategoryRead, CategoryUpdate
from ..services.auth import get_current_user, get_db

router = APIRouter(prefix="/api/categories", tags=["categories"])


def _load_category_stats(db: Session, category_ids: list[int] | None = None):
    query = db.query(
        TextSample.category_id.label("category_id"),
        func.count(TextSample.id).label("total"),
        func.sum(case((TextSample.state == "pending", 1), else_=0)).label("pending"),
        func.sum(case((TextSample.state == "in_annotation", 1), else_=0)).label("in_progress"),
        func.sum(case((TextSample.state == "awaiting_cross_validation", 1), else_=0)).label("awaiting"),
    )
    if category_ids:
        query = query.filter(TextSample.category_id.in_(category_ids))
    rows = query.group_by(TextSample.category_id).all()
    return {row.category_id: row for row in rows}


def _serialize_category(category: Category, stats) -> CategoryRead:
    return CategoryRead(
        id=category.id,
        name=category.name,
        description=category.description,
        is_hidden=category.is_hidden,
        created_at=category.created_at,
        total_texts=int(stats.total) if stats else 0,
        remaining_texts=int(stats.pending) if stats else 0,
        in_progress_texts=int(stats.in_progress) if stats else 0,
        awaiting_review_texts=int(stats.awaiting) if stats else 0,
    )


@router.get("/", response_model=list[CategoryRead])
def list_categories(db: Session = Depends(get_db), _: str = Depends(get_current_user)):
    categories = db.query(Category).order_by(Category.created_at.desc(), Category.id.desc()).all()
    stats_map = _load_category_stats(db, [category.id for category in categories])
    return [_serialize_category(category, stats_map.get(category.id)) for category in categories]


@router.post("/", response_model=CategoryRead, status_code=status.HTTP_201_CREATED)
def create_category(
    category: CategoryCreate,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    if db.query(Category).filter(Category.name == category.name).first():
        raise HTTPException(status_code=400, detail="Category already exists")
    obj = Category(name=category.name, description=category.description)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    stats = _load_category_stats(db, [obj.id]).get(obj.id)
    return _serialize_category(obj, stats)


@router.put("/{category_id}", response_model=CategoryRead)
def update_category(
    category_id: int,
    payload: CategoryUpdate,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    category = db.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    if payload.name and payload.name != category.name:
        existing = db.query(Category).filter(Category.name == payload.name).first()
        if existing:
            raise HTTPException(status_code=400, detail="Category with this name already exists")
        category.name = payload.name
    if payload.description is not None:
        category.description = payload.description
    if payload.is_hidden is not None:
        category.is_hidden = payload.is_hidden
    db.commit()
    db.refresh(category)
    stats = _load_category_stats(db, [category.id]).get(category.id)
    return _serialize_category(category, stats)


# @router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
# def delete_category(
#     category_id: int,
#     db: Session = Depends(get_db),
#     _: str = Depends(get_current_user),
# ):
#     category = db.get(Category, category_id)
#     if not category:
#         raise HTTPException(status_code=404, detail="Category not found")
#     has_texts = db.query(TextSample.id).filter(TextSample.category_id == category_id).first()
#     if has_texts:
#         raise HTTPException(status_code=400, detail="Cannot remove a category that contains texts")
#     db.delete(category)
#     db.commit()
