import os
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects.sqlite import JSON

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.models import Annotation, AnnotationVersion, Base, Category, ErrorType, TextSample, User
from app.schemas.common import AnnotationSaveRequest
from app.services.annotation_saves import (
    AnnotationSaveError,
    ensure_payload_text_identity,
    save_annotation_drafts,
    sha256_text,
    sha256_tokens,
)


AUTHOR_ID = uuid.uuid4()


def setup_function():
    db.configure_engine("sqlite:///:memory:")
    tables = [
        User.__table__,
        Category.__table__,
        TextSample.__table__,
        ErrorType.__table__,
        Annotation.__table__,
        AnnotationVersion.__table__,
    ]
    Annotation.__table__.c.payload.type = JSON()
    AnnotationVersion.__table__.c.snapshot.type = JSON()
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    Base.metadata.create_all(bind=db.engine, tables=tables)


def teardown_function():
    tables = [
        User.__table__,
        Category.__table__,
        TextSample.__table__,
        ErrorType.__table__,
        Annotation.__table__,
        AnnotationVersion.__table__,
    ]
    Base.metadata.drop_all(bind=db.engine, tables=tables)


def seed_text(session):
    category = Category(name="SaveService")
    error_type = ErrorType(en_name="ERR", default_color="#123456", is_active=True)
    text = TextSample(content="hello world", category=category, required_annotations=1)
    session.add_all([category, error_type, text])
    session.flush()
    return text, error_type


def test_ensure_payload_text_identity_populates_missing_snapshot():
    payload = {
        "operation": "replace",
        "before_tokens": ["hello"],
        "after_tokens": [{"id": "a1", "text": "hi", "origin": "base"}],
    }

    ensure_payload_text_identity(payload, SimpleNamespace(content="hello world"))

    assert payload["text_sha256"] == sha256_text("hello world")
    assert payload["text_tokens"] == ["hello", "world"]
    assert payload["text_tokens_sha256"]


def test_save_annotation_drafts_creates_independent_matching_annotation():
    other_author_id = uuid.uuid4()
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        session.add(
            Annotation(
                text_id=text.id,
                author_id=other_author_id,
                start_token=0,
                end_token=0,
                replacement="hi",
                payload={
                    "operation": "replace",
                    "before_tokens": ["hello"],
                    "after_tokens": [{"id": "a1", "text": "hi", "origin": "base"}],
                    "text_sha256": sha256_text("hello world"),
                },
                error_type_id=error_type.id,
            )
        )
        session.commit()

    with db.SessionLocal() as session:
        text = session.query(TextSample).one()
        error_type = session.query(ErrorType).one()
        request = AnnotationSaveRequest(
            annotations=[
                {
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "hi",
                    "error_type_id": error_type.id,
                    "payload": {
                        "operation": "replace",
                        "before_tokens": ["hello"],
                        "after_tokens": [{"id": "a1", "text": "hi", "origin": "base"}],
                        "text_sha256": sha256_text("hello world"),
                    },
                }
            ],
            client_version=0,
        )

        saved = save_annotation_drafts(session, text, AUTHOR_ID, request)

    assert len(saved) == 1
    with db.SessionLocal() as session:
        by_self = session.query(Annotation).filter_by(author_id=AUTHOR_ID).all()
        by_other = session.query(Annotation).filter_by(author_id=other_author_id).all()
        assert len(by_self) == 1
        assert len(by_other) == 1


def canonical_payload(*, correction_id="correction-1", operation="replace"):
    return {
        "schema_version": 2,
        "client_correction_id": correction_id,
        "operation": operation,
        "before_tokens": ["base-0"],
        "after_tokens": [{"id": f"{correction_id}-after", "text": "hi", "origin": "base"}],
        "text_sha256": sha256_text("hello world"),
        "text_tokens": ["hello", "world"],
        "text_tokens_sha256": sha256_tokens(["hello", "world"]),
        "source": "manual",
    }


def test_canonical_save_rejects_unstable_before_token_ids():
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        payload = canonical_payload()
        payload["before_tokens"] = ["token-42"]
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            annotations=[
                {
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "hi",
                    "error_type_id": error_type.id,
                    "payload": payload,
                }
            ],
        )

        with pytest.raises(AnnotationSaveError, match="base-N"):
            save_annotation_drafts(session, text, AUTHOR_ID, request)


def test_canonical_save_rejects_incomplete_move():
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        payload = canonical_payload(operation="move")
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            annotations=[
                {
                    "start_token": 1,
                    "end_token": 1,
                    "replacement": "hello",
                    "error_type_id": error_type.id,
                    "payload": payload,
                }
            ],
        )

        with pytest.raises(AnnotationSaveError, match="move_from"):
            save_annotation_drafts(session, text, AUTHOR_ID, request)


def test_canonical_save_rejects_render_mismatch_without_writing():
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            expected_target="different target",
            annotations=[
                {
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "hi",
                    "error_type_id": error_type.id,
                    "payload": canonical_payload(),
                }
            ],
        )

        with pytest.raises(AnnotationSaveError, match="corrected text differ"):
            save_annotation_drafts(session, text, AUTHOR_ID, request)

        assert session.query(Annotation).count() == 0


def test_canonical_full_snapshot_replaces_only_current_author_rows():
    other_author = uuid.uuid4()
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        old = Annotation(
            text_id=text.id,
            author_id=AUTHOR_ID,
            start_token=1,
            end_token=1,
            replacement="earth",
            payload={"operation": "replace", "before_tokens": ["token-9"], "after_tokens": []},
            error_type_id=error_type.id,
        )
        foreign = Annotation(
            text_id=text.id,
            author_id=other_author,
            start_token=0,
            end_token=0,
            replacement="hey",
            payload={"operation": "replace", "before_tokens": ["token-1"], "after_tokens": []},
            error_type_id=error_type.id,
        )
        session.add_all([old, foreign])
        session.commit()
        request = AnnotationSaveRequest(
            schema_version=2,
            client_version=1,
            replace_existing=True,
            annotations=[
                {
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "hi",
                    "error_type_id": error_type.id,
                    "payload": canonical_payload(),
                }
            ],
        )

        saved = save_annotation_drafts(session, text, AUTHOR_ID, request)

    assert len(saved) == 1
    with db.SessionLocal() as session:
        own = session.query(Annotation).filter_by(author_id=AUTHOR_ID).all()
        foreign_rows = session.query(Annotation).filter_by(author_id=other_author).all()
        assert len(own) == 1
        assert own[0].replacement == "hi"
        assert own[0].payload["client_correction_id"] == "correction-1"
        assert len(foreign_rows) == 1


def test_canonical_same_span_corrections_keep_their_client_identity():
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        rows = []
        for cid, value in [("first", "hi"), ("second", "hey")]:
            payload = canonical_payload(correction_id=cid)
            payload["after_tokens"][0]["text"] = value
            row = Annotation(
                text_id=text.id,
                author_id=AUTHOR_ID,
                start_token=0,
                end_token=0,
                replacement=value,
                error_type_id=error_type.id,
                payload=payload,
            )
            session.add(row)
            rows.append(row)
        session.commit()
        ids = [row.id for row in rows]
        request_rows = []
        for cid, value in [("first", "hello"), ("second", "greetings")]:
            payload = canonical_payload(correction_id=cid)
            payload["after_tokens"][0]["text"] = value
            # An older span-keyed frontend map can point both corrections at the same id.
            request_rows.append(
                dict(
                    id=ids[1],
                    start_token=0,
                    end_token=0,
                    replacement=value,
                    error_type_id=error_type.id,
                    payload=payload,
                )
            )
        request = AnnotationSaveRequest(
            schema_version=2, client_version=1, replace_existing=True, annotations=request_rows
        )
        saved = save_annotation_drafts(session, text, AUTHOR_ID, request)
        assert [row.id for row in saved] == ids
        assert [row.replacement for row in saved] == ["hello", "greetings"]


@pytest.mark.parametrize("stale_row_id", [False, True])
def test_v2_new_insert_and_replace_at_old_span_survive_reload(stale_row_id):
    from app.services.annotation_rendering import render_corrected_text

    with db.SessionLocal() as session:
        text, label = seed_text(session)

        def item(cid, value, op="replace", aid=None):
            p = canonical_payload(correction_id=cid, operation=op)
            p["after_tokens"][0].update(text=value, space_before=(op != "insert"))
            if op == "insert":
                p["before_tokens"] = []
            return dict(
                id=aid,
                start_token=0,
                end_token=0,
                replacement=value,
                error_type_id=label.id,
                payload=p,
            )

        old = save_annotation_drafts(
            session,
            text,
            AUTHOR_ID,
            AnnotationSaveRequest(
                schema_version=2, replace_existing=True, annotations=[item("old", "hi")]
            ),
        )[0]
        old_id = old.id
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            annotations=[
                item("insert", "new", "insert", old_id if stale_row_id else None),
                item("replace", "hey", aid=old_id if stale_row_id else None),
            ],
            expected_target="new hey world",
            client_version=old.version,
        )
        saved = save_annotation_drafts(session, text, AUTHOR_ID, request)
        assert len({a.id for a in saved}) == 2
        session.expire_all()
        rows = session.query(Annotation).filter_by(text_id=text.id, author_id=AUTHOR_ID).all()
        assert {a.payload["client_correction_id"] for a in rows} == {"insert", "replace"}
        assert render_corrected_text(text.content, rows) == request.expected_target
        # A second save with stable identities must update, not duplicate, both rows.
        before_ids = {a.id for a in rows}
        request.client_version = max(a.version for a in rows)
        saved = save_annotation_drafts(session, text, AUTHOR_ID, request)
        assert {a.id for a in saved} == before_ids


def test_v2_persisted_mismatch_rolls_back_rows_and_history():
    from sqlalchemy import event

    with db.SessionLocal() as session:
        text, label = seed_text(session)

        def corrupt(_mapper, _connection, target):
            target.replacement = "corrupted"

        event.listen(Annotation, "before_insert", corrupt)
        try:
            request = AnnotationSaveRequest(
                schema_version=2,
                replace_existing=True,
                expected_target="hi world",
                annotations=[
                    dict(
                        start_token=0,
                        end_token=0,
                        replacement="hi",
                        error_type_id=label.id,
                        payload=canonical_payload(),
                    )
                ],
            )
            with pytest.raises(AnnotationSaveError, match="Persisted"):
                save_annotation_drafts(session, text, AUTHOR_ID, request)
        finally:
            event.remove(Annotation, "before_insert", corrupt)
        assert session.query(Annotation).count() == 0
        assert session.query(AnnotationVersion).count() == 0


def test_v2_failure_restores_previous_draft_and_versions():
    from sqlalchemy import event

    with db.SessionLocal() as session:
        text, label = seed_text(session)
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            annotations=[
                dict(
                    start_token=0,
                    end_token=0,
                    replacement="hi",
                    error_type_id=label.id,
                    payload=canonical_payload(),
                )
            ],
        )
        old_id = save_annotation_drafts(session, text, AUTHOR_ID, request)[0].id
        version_count = session.query(AnnotationVersion).count()
        request.client_version = session.get(Annotation, old_id).version

        def corrupt(_mapper, _connection, target):
            target.replacement = "bad"

        event.listen(Annotation, "before_update", corrupt)
        try:
            request.annotations[0].replacement = "hello"
            request.annotations[0].payload.after_tokens[0].text = "hello"
            with pytest.raises(AnnotationSaveError, match="Persisted"):
                save_annotation_drafts(session, text, AUTHOR_ID, request)
        finally:
            event.remove(Annotation, "before_update", corrupt)
        row = session.get(Annotation, old_id)
        assert row.replacement == "hi"
        assert session.query(AnnotationVersion).count() == version_count


@pytest.mark.parametrize("client_version", [0, 2])
def test_v2_rejects_mismatched_revision_including_zero(client_version):
    with db.SessionLocal() as session:
        text, label = seed_text(session)
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            annotations=[
                dict(
                    start_token=0,
                    end_token=0,
                    replacement="hi",
                    error_type_id=label.id,
                    payload=canonical_payload(),
                )
            ],
        )
        row = save_annotation_drafts(session, text, AUTHOR_ID, request)[0]
        aid = row.id
        request.client_version = client_version
        with pytest.raises(AnnotationSaveError, match="stale"):
            save_annotation_drafts(session, text, AUTHOR_ID, request)
        assert session.get(Annotation, aid).version == 1


def test_v2_can_add_corrections_after_clearing_draft():
    with db.SessionLocal() as session:
        text, label = seed_text(session)
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            expected_target="hi world",
            annotations=[
                dict(
                    start_token=0,
                    end_token=0,
                    replacement="hi",
                    error_type_id=label.id,
                    payload=canonical_payload(),
                )
            ],
        )
        first = save_annotation_drafts(session, text, AUTHOR_ID, request)[0]
        previous_version = first.version
        cleared = save_annotation_drafts(
            session,
            text,
            AUTHOR_ID,
            AnnotationSaveRequest(
                schema_version=2,
                replace_existing=True,
                client_version=previous_version,
                expected_target="hello world",
                annotations=[],
            ),
        )
        assert cleared == []
        assert session.query(Annotation).count() == 0
        # The frontend advances its revision when an empty save returns no rows.
        request.client_version = previous_version + 1
        saved = save_annotation_drafts(session, text, AUTHOR_ID, request)
        assert len(saved) == 1
        assert saved[0].version == request.client_version + 1
        assert saved[0].replacement == "hi"
