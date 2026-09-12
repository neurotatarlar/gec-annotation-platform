import copy
import os
import uuid
from datetime import timedelta

import pytest
from sqlalchemy.dialects.sqlite import JSON

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
import app.services.annotation_repairs as annotation_repairs
from app.models import (
    Annotation,
    AnnotationRepairApplication,
    AnnotationRepairBatch,
    AnnotationRepairItem,
    AnnotationRepairProposalRevision,
    AnnotationTask,
    AnnotationVersion,
    Base,
    Category,
    ErrorType,
    TextSample,
    User,
)
from app.services.annotation_repairs import (
    AnnotationRepairError,
    apply_manifest,
    build_approved_manifest,
    build_repair_audit_report,
    build_repair_bundle,
    build_review_state,
    content_hash,
    export_repair_snapshot,
    import_repair_bundle,
    normalize_punctuation_spacing,
    record_fingerprint,
    revise_repair_proposal,
)
from app.services.annotation_saves import sha256_text, sha256_tokens
from app.services.annotation_payloads import validate_canonical_annotation_payload


TABLES = [
    User.__table__,
    Category.__table__,
    TextSample.__table__,
    AnnotationTask.__table__,
    ErrorType.__table__,
    Annotation.__table__,
    AnnotationVersion.__table__,
    AnnotationRepairBatch.__table__,
    AnnotationRepairItem.__table__,
    AnnotationRepairProposalRevision.__table__,
    AnnotationRepairApplication.__table__,
]


def test_punctuation_spacing_normalization_is_conservative_and_audited():
    normalized, audit = normalize_punctuation_spacing("Сүз ,икенче.Соң  бар")

    assert normalized == "Сүз, икенче. Соң  бар"
    assert audit["status"] == "applied"
    assert [change["rule"] for change in audit["changes"]] == [
        "attach_closing_punctuation",
        "separate_after_closing_punctuation",
        "separate_after_closing_punctuation",
    ]
    assert audit["input_sha256"] != audit["output_sha256"]


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("3 , 4 көн", "3,4 көн"),
        ("т.д. сүз", "т.д. сүз"),
        ("Сүз.\nИкенче", "Сүз.\nИкенче"),
        ("Сүз\n ,икенче", "Сүз\n ,икенче"),
        ("Сүз ! ?", "Сүз!?"),
        ("https://example.org/path?q=1.2", "https://example.org/path?q=1.2"),
        ("Кара:https://example.org/path", "Кара:https://example.org/path"),
        ("ашарга- эчәргә", "ашарга- эчәргә"),
    ],
)
def test_punctuation_spacing_normalization_protects_ambiguous_boundaries(source, expected):
    normalized, _ = normalize_punctuation_spacing(source)
    assert normalized == expected


def setup_function():
    db.configure_engine("sqlite:///:memory:")
    for column in (
        Annotation.__table__.c.payload,
        AnnotationVersion.__table__.c.snapshot,
        AnnotationRepairItem.__table__.c.proposed_annotations,
        AnnotationRepairItem.__table__.c.recovery_evidence,
        AnnotationRepairProposalRevision.__table__.c.proposed_annotations,
        AnnotationRepairApplication.__table__.c.before_snapshot,
        AnnotationRepairApplication.__table__.c.after_snapshot,
    ):
        column.type = JSON()
    Base.metadata.create_all(bind=db.engine, tables=TABLES)


def teardown_function():
    Base.metadata.drop_all(bind=db.engine, tables=reversed(TABLES))


def seed_legacy_submission(session):
    author = User(id=uuid.uuid4(), username="repair-author", password_hash="hash", role="annotator")
    category = Category(id=3, name="Category 3")
    error_type = ErrorType(en_name="Spelling", default_color="#123456", is_active=True)
    text = TextSample(content="Alpha beta", category=category, required_annotations=1)
    session.add_all([author, category, error_type, text])
    session.flush()
    task = AnnotationTask(text_id=text.id, annotator_id=author.id, status="submitted")
    annotation = Annotation(
        text_id=text.id,
        author_id=author.id,
        start_token=0,
        end_token=0,
        replacement="Omega",
        error_type_id=error_type.id,
        payload={
            "operation": "replace",
            "before_tokens": ["token-40"],
            "after_tokens": [{"id": "token-50", "text": "Omega", "origin": "base"}],
            "text_sha256": sha256_text(text.content),
            "text_tokens": ["Alpha", "beta"],
            "text_tokens_sha256": sha256_tokens(["Alpha", "beta"]),
            "source": "manual",
        },
    )
    session.add_all([task, annotation])
    session.commit()
    return text.id


def test_repair_bundle_review_gate_and_atomic_apply():
    with db.SessionLocal() as session:
        text_id = seed_legacy_submission(session)
        snapshot = export_repair_snapshot(session, 3)

    bundle = build_repair_bundle(snapshot)
    assert len(bundle["items"]) == 1
    assert bundle["items"][0]["proposed_target"] == "Omega beta"
    assert snapshot["format"] == "annotation-repair-snapshot-v2"
    assert bundle["format"] == "annotation-repair-bundle-v2"
    assert bundle["items"][0]["restored_target"] == "Omega beta"
    proposal = bundle["items"][0]["proposed_annotations"][0]
    assert proposal["payload"]["schema_version"] == 2
    assert proposal["payload"]["before_tokens"] == ["base-0"]

    with db.SessionLocal() as session:
        batch = import_repair_bundle(session, bundle)
        with pytest.raises(AnnotationRepairError, match="must be approved"):
            build_approved_manifest(session, batch.id)
        item = session.query(AnnotationRepairItem).one()
        item.status = "approved"
        session.commit()
        manifest = build_approved_manifest(session, batch.id)
        session.delete(batch)
        session.commit()
        dry_run = apply_manifest(session, manifest, dry_run=True)
        assert dry_run["item_count"] == 1
        assert session.query(Annotation).one().payload.get("schema_version") is None
        receipt = apply_manifest(session, manifest, dry_run=False)
        assert receipt["dry_run"] is False
        assert len(receipt["before_m2_sha256"]) == 64
        assert len(receipt["after_m2_sha256"]) == 64

    with db.SessionLocal() as session:
        repaired = session.query(Annotation).filter_by(text_id=text_id).one()
        assert repaired.payload["schema_version"] == 2
        assert repaired.payload["before_tokens"] == ["base-0"]
        application = session.query(AnnotationRepairApplication).one()
        assert application.before_m2_sha256 == receipt["before_m2_sha256"]
        assert application.after_m2_sha256 == receipt["after_m2_sha256"]


def test_bundle_import_and_manifest_reject_tampered_recovery_content():
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        bundle = build_repair_bundle(export_repair_snapshot(session, 3))
        tampered_bundle = copy.deepcopy(bundle)
        tampered_bundle["items"][0]["recovery_evidence"]["confidence"] = "tampered"
        tampered_bundle["batch_id"] = content_hash(
            {key: value for key, value in tampered_bundle.items() if key != "batch_id"}
        )
        with pytest.raises(AnnotationRepairError, match="Recovery evidence hash"):
            import_repair_bundle(session, tampered_bundle)

        batch = import_repair_bundle(session, bundle)
        item = batch.items[0]
        item.status = "approved"
        session.commit()
        manifest = build_approved_manifest(session, batch.id)
        manifest["items"][0]["restored_target"] = "tampered"
        manifest["manifest_hash"] = content_hash(
            {key: value for key, value in manifest.items() if key != "manifest_hash"}
        )
        with pytest.raises(AnnotationRepairError, match="evidence changed"):
            apply_manifest(session, manifest, dry_run=True)


def test_repair_audit_report_lists_review_categories():
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        snapshot = export_repair_snapshot(session, 3)
    evidence = snapshot["records"][0]["recovery_evidence"]
    evidence["possible_deleted_rows"] = True
    evidence["evidence_hash"] = content_hash(
        {key: value for key, value in evidence.items() if key != "evidence_hash"}
    )
    snapshot["snapshot_hash"] = content_hash(
        {key: value for key, value in snapshot.items() if key not in {"created_at", "snapshot_hash"}}
    )
    bundle = build_repair_bundle(snapshot)

    report = build_repair_audit_report(bundle)

    text_id = snapshot["records"][0]["text_id"]
    assert report["item_count"] == 1
    assert report["categories"]["approval_state_uncertain"] == {
        "count": 1,
        "text_ids": [text_id],
    }
    assert report["categories"]["low_confidence"]["count"] == 1


def test_repair_manifest_aborts_when_source_state_changes():
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        bundle = build_repair_bundle(export_repair_snapshot(session, 3))
        batch = import_repair_bundle(session, bundle)
        item = session.query(AnnotationRepairItem).one()
        item.status = "approved"
        session.commit()
        manifest = build_approved_manifest(session, batch.id)
        annotation = session.query(Annotation).one()
        annotation.version += 1
        session.commit()

        with pytest.raises(AnnotationRepairError, match="state changed"):
            apply_manifest(session, manifest, dry_run=True)


def test_snapshot_restores_latest_version_at_submission_and_flags_later_activity():
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        task = session.query(AnnotationTask).one()
        annotation = session.query(Annotation).one()
        session.add(
            AnnotationVersion(
                annotation_id=annotation.id,
                version=1,
                snapshot={
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "Approved",
                    "error_type_id": annotation.error_type_id,
                    "payload": {
                        **annotation.payload,
                        "after_tokens": [{"id": "approved", "text": "Approved", "origin": "base"}],
                    },
                },
                created_at=task.updated_at,
            )
        )
        session.commit()
        annotation.replacement = "Later"
        annotation.payload = {
            **annotation.payload,
            "after_tokens": [{"id": "later", "text": "Later", "origin": "base"}],
        }
        annotation.version = 2
        later_annotation = Annotation(
            text_id=annotation.text_id,
            author_id=annotation.author_id,
            start_token=1,
            end_token=1,
            replacement="After submission",
            error_type_id=annotation.error_type_id,
            payload={
                **annotation.payload,
                "after_tokens": [
                    {"id": "after-submission", "text": "After submission", "origin": "base"}
                ],
            },
            created_at=task.updated_at + timedelta(seconds=2),
        )
        session.add(
            AnnotationVersion(
                annotation_id=annotation.id,
                version=2,
                snapshot={
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "Later",
                    "error_type_id": annotation.error_type_id,
                    "payload": annotation.payload,
                },
                created_at=task.updated_at + timedelta(seconds=1),
            )
        )
        session.add(later_annotation)
        session.commit()

        snapshot = export_repair_snapshot(session, 3)
        record = snapshot["records"][0]
        assert record["approval_annotations"][0]["replacement"] == "Approved"
        assert record["annotations"][0]["replacement"] == "Later"
        assert record["recovery_evidence"]["excluded_after_submission_ids"] == [later_annotation.id]
        assert record["recovery_evidence"]["possible_deleted_rows"] is True
        bundle = build_repair_bundle(snapshot)
        assert bundle["items"][0]["restored_target"] == "Approved beta"
        assert bundle["items"][0]["current_target"] == "Later After submission"


def test_uncertain_recovery_requires_acknowledgement_and_old_batch_is_superseded():
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        snapshot = export_repair_snapshot(session, 3)
        first = import_repair_bundle(session, build_repair_bundle(snapshot))
        second_snapshot = copy.deepcopy(snapshot)
        second_snapshot["records"][0]["recovery_evidence"]["possible_deleted_rows"] = True
        evidence = second_snapshot["records"][0]["recovery_evidence"]
        evidence["evidence_hash"] = content_hash(
            {key: value for key, value in evidence.items() if key != "evidence_hash"}
        )
        second_snapshot["snapshot_hash"] = content_hash(
            {
                key: value
                for key, value in second_snapshot.items()
                if key not in {"created_at", "snapshot_hash"}
            }
        )
        second = import_repair_bundle(session, build_repair_bundle(second_snapshot))
        assert first.status == "superseded"
        with pytest.raises(AnnotationRepairError, match="Superseded"):
            build_approved_manifest(session, first.id)
        item = second.items[0]
        item.status = "approved"
        session.commit()
        with pytest.raises(AnnotationRepairError, match="acknowledgement"):
            build_approved_manifest(session, second.id)
        item.uncertainty_acknowledged = True
        session.commit()
        assert build_approved_manifest(session, second.id)["format"] == "annotation-repair-manifest-v2"


def test_frontend_projection_is_exact_target_and_mismatch_requires_label_review():
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        snapshot = export_repair_snapshot(session, 3)

    item = build_repair_bundle(
        snapshot,
        frontend_projections={snapshot["records"][0]["text_id"]: "Omega, beta"},
        require_frontend_projection=True,
    )["items"][0]

    assert item["restored_target"] == "Omega beta"
    assert item["proposed_target"] == "Omega beta"
    assert item["recovery_evidence"]["projection_mismatch"] is True
    assert item["recovery_evidence"]["backend_restored_target"] == "Omega beta"
    assert item["recovery_evidence"]["frontend_restored_target"] == "Omega, beta"
    assert "frontend_backend_mismatch" in item["risk"]
    assert not any(
        annotation["payload"].get("label_needs_review")
        for annotation in item["proposed_annotations"]
    )


def test_reviewer_target_override_is_exact_and_requires_changed_label_review():
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        snapshot = export_repair_snapshot(session, 3)

    item = build_repair_bundle(
        snapshot,
        target_overrides={snapshot["records"][0]["text_id"]: "Gamma beta"},
    )["items"][0]

    assert item["restored_target"] == "Omega beta"
    assert item["proposed_target"] == "Gamma beta"
    assert "reviewer_target" in item["risk"]
    assert item["confidence"] == "low"
    assert item["recovery_evidence"]["whitespace_normalization"]["status"] == (
        "skipped_reviewer_target"
    )
    assert any(
        annotation["payload"].get("label_needs_review")
        for annotation in item["proposed_annotations"]
    )


def test_review_state_preserves_approved_candidate_and_rejects_changed_source_state():
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        snapshot = export_repair_snapshot(session, 3)
        batch = import_repair_bundle(session, build_repair_bundle(snapshot))
        item = session.query(AnnotationRepairItem).one()
        item.status = "approved"
        session.commit()
        review_state = build_review_state(session, batch.id)

    unchanged = build_repair_bundle(
        snapshot,
        review_state,
        target_overrides={snapshot["records"][0]["text_id"]: "Gamma beta"},
    )
    assert unchanged["items"][0]["status"] == "approved"
    assert unchanged["items"][0]["proposed_target"] == "Omega beta"
    assert unchanged["items"][0]["proposed_annotations"] == review_state["items"][0]["proposed_annotations"]
    assert unchanged["items"][0]["recovery_evidence"]["whitespace_normalization"]["status"] == (
        "skipped_approved"
    )

    tampered_state = copy.deepcopy(review_state)
    tampered_state["items"][0]["proposed_target"] = "Tampered beta"
    with pytest.raises(AnnotationRepairError, match="review-state hash"):
        build_repair_bundle(snapshot, tampered_state)

    changed_snapshot = copy.deepcopy(snapshot)
    changed_snapshot["records"][0]["annotations"][0]["replacement"] = "Changed"
    changed_snapshot["records"][0]["annotations"][0]["payload"]["after_tokens"][0]["text"] = "Changed"
    changed_snapshot["records"][0]["fingerprint"] = record_fingerprint(
        changed_snapshot["records"][0]["source"],
        changed_snapshot["records"][0]["annotations"],
    )
    changed_snapshot["snapshot_hash"] = content_hash(
        {key: value for key, value in changed_snapshot.items() if key not in {"created_at", "snapshot_hash"}}
    )
    with pytest.raises(AnnotationRepairError, match="Approved source state changed"):
        build_repair_bundle(changed_snapshot, review_state)


def test_bundle_normalizes_punctuation_spacing_and_assigns_punctuation_label():
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        text = session.query(TextSample).one()
        annotation = session.query(Annotation).one()
        text.content = "Alpha,beta"
        annotation.payload = {
            **annotation.payload,
            "text_sha256": sha256_text(text.content),
            "text_tokens": ["Alpha", ",", "beta"],
            "text_tokens_sha256": sha256_tokens(["Alpha", ",", "beta"]),
        }
        session.commit()
        text_id = text.id
        snapshot = export_repair_snapshot(session, 3)

    item = build_repair_bundle(snapshot)["items"][0]

    assert item["proposed_target"] == "Omega, beta"
    assert item["recovery_evidence"]["whitespace_normalization"]["status"] == "applied"
    spacing_operations = [
        annotation
        for annotation in item["proposed_annotations"]
        if annotation["payload"]["source"] == "repair-spacing"
    ]
    assert spacing_operations
    assert all(annotation["error_type_id"] == 4 for annotation in spacing_operations)
    audit = build_repair_audit_report(build_repair_bundle(snapshot))
    assert audit["categories"]["whitespace_normalized"]["text_ids"] == [text_id]
    assert audit["whitespace_normalization"]["changed_boundary_count"] == 1


def test_bundle_audits_and_skips_unrepresentable_spacing(monkeypatch):
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        text = session.query(TextSample).one()
        annotation = session.query(Annotation).one()
        text.content = "Alpha,beta"
        annotation.payload = {
            **annotation.payload,
            "text_sha256": sha256_text(text.content),
            "text_tokens": ["Alpha", ",", "beta"],
            "text_tokens_sha256": sha256_tokens(["Alpha", ",", "beta"]),
        }
        session.commit()
        snapshot = export_repair_snapshot(session, 3)

    monkeypatch.setattr(
        annotation_repairs,
        "_reconstruct_canonical_diff",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AnnotationRepairError("line layout cannot round-trip")
        ),
    )
    item = build_repair_bundle(snapshot)["items"][0]
    spacing = item["recovery_evidence"]["whitespace_normalization"]

    assert item["proposed_target"] == "Omega,beta"
    assert spacing["status"] == "skipped_unrepresentable"
    assert spacing["changes"] == []
    assert len(spacing["attempted_changes"]) == 1
    assert spacing["skipped"][-1]["rule"] == "canonical_round_trip_failed"


def test_manifest_rejects_an_approved_unlabeled_correction():
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        batch = import_repair_bundle(session, build_repair_bundle(export_repair_snapshot(session, 3)))
        item = session.query(AnnotationRepairItem).one()
        item.status = "approved"
        proposed = copy.deepcopy(item.proposed_annotations)
        proposed[0]["error_type_id"] = None
        item.proposed_annotations = proposed
        session.commit()

        with pytest.raises(AnnotationRepairError, match="unconfirmed"):
            build_approved_manifest(session, batch.id)


def test_manual_target_edit_requires_label_confirmation_and_keeps_revision_history():
    reviewer_id = uuid.uuid4()
    with db.SessionLocal() as session:
        seed_legacy_submission(session)
        batch = import_repair_bundle(session, build_repair_bundle(export_repair_snapshot(session, 3)))
        item = session.query(AnnotationRepairItem).one()
        error_type_id = session.query(ErrorType.id).scalar()

        revise_repair_proposal(
            session,
            item,
            reviewer_id,
            proposed_target="Gamma beta",
        )

        assert item.proposal_revision == 2
        assert item.proposed_target == "Gamma beta"
        assert item.status == "pending"
        assert len(item.proposed_annotations) == 1
        proposal = item.proposed_annotations[0]
        assert proposal["payload"]["label_needs_review"] is True
        with pytest.raises(AnnotationRepairError, match="unconfirmed"):
            item.status = "approved"
            session.commit()
            build_approved_manifest(session, batch.id)

        item.status = "pending"
        correction_id = proposal["payload"]["client_correction_id"]
        revise_repair_proposal(
            session,
            item,
            reviewer_id,
            labels={correction_id: error_type_id},
        )

        assert item.proposal_revision == 3
        assert "label_needs_review" not in item.proposed_annotations[0]["payload"]
        assert item.proposed_annotations[0]["error_type_id"] == error_type_id
        assert session.query(AnnotationRepairProposalRevision).count() == 3

        revise_repair_proposal(session, item, reviewer_id, restore_revision=1)

        assert item.proposal_revision == 4
        assert item.proposed_target == "Omega beta"
        assert "manual_edit" not in item.risk
        assert session.query(AnnotationRepairProposalRevision).count() == 4


def test_manual_target_edit_preserves_only_unchanged_operation_labels():
    tokens = ["Alpha", "middle", "beta"]
    annotations = [
        legacy_annotation(10, 0, 0, "Omega", ["token-40"], tokens),
        legacy_annotation(11, 2, 2, "Earth", ["token-42"], tokens),
    ]
    record = {
        "text_id": 10,
        "task_id": 10,
        "author_id": str(uuid.uuid4()),
        "source": "Alpha middle beta",
        "annotations": annotations,
        "annotation_history": {},
    }
    record["fingerprint"] = record_fingerprint(record["source"], annotations)

    with db.SessionLocal() as session:
        reviewer = User(username="proposal-reviewer", password_hash="hash", role="admin")
        session.add(reviewer)
        session.commit()
        bundle = build_repair_bundle(repair_snapshot(record))
        item = import_repair_bundle(session, bundle).items[0]

        revise_repair_proposal(
            session,
            item,
            reviewer.id,
            proposed_target="Omega middle World",
        )

        by_start = {annotation["start_token"]: annotation for annotation in item.proposed_annotations}
        assert by_start[0]["error_type_id"] == 1
        assert "label_needs_review" not in by_start[0]["payload"]
        assert by_start[2]["error_type_id"] == 1
        assert by_start[2]["payload"]["label_needs_review"] is True


def test_manual_target_edit_never_implicitly_confirms_a_suggested_label():
    tokens = ["Alpha", "middle", "beta"]
    annotations = [legacy_annotation(10, 0, 0, "Omega", ["token-40"], tokens)]
    record = {
        "text_id": 10,
        "task_id": 10,
        "author_id": str(uuid.uuid4()),
        "source": "Alpha middle beta",
        "annotations": annotations,
        "annotation_history": {},
    }
    record["fingerprint"] = record_fingerprint(record["source"], annotations)

    reviewer_id = uuid.uuid4()
    with db.SessionLocal() as session:
        session.add(ErrorType(en_name="Spelling", default_color="#123456", is_active=True))
        session.commit()
        item = import_repair_bundle(
            session,
            build_repair_bundle(repair_snapshot(record)),
        ).items[0]
        error_type_id = session.query(ErrorType.id).scalar()

        revise_repair_proposal(session, item, reviewer_id, proposed_target="Gamma middle beta")
        revise_repair_proposal(session, item, reviewer_id, proposed_target="Gamma middle Earth")

        by_start = {annotation["start_token"]: annotation for annotation in item.proposed_annotations}
        assert by_start[0]["payload"]["label_needs_review"] is True
        assert by_start[2]["payload"]["label_needs_review"] is True

        revise_repair_proposal(
            session,
            item,
            reviewer_id,
            labels={
                annotation["payload"]["client_correction_id"]: error_type_id
                for annotation in item.proposed_annotations
            },
        )
        revise_repair_proposal(session, item, reviewer_id, proposed_target="Gamma middle World")

        by_start = {annotation["start_token"]: annotation for annotation in item.proposed_annotations}
        assert "label_needs_review" not in by_start[0]["payload"]
        assert by_start[2]["payload"]["label_needs_review"] is True


def repair_snapshot(record):
    body = {
        "format": "annotation-repair-snapshot-v1",
        "category_id": 3,
        "records": [record],
    }
    body["snapshot_hash"] = content_hash(body)
    return body


def legacy_annotation(annotation_id, start, end, replacement, before, tokens, *, operation="replace"):
    after = []
    if replacement is not None:
        after = [{"id": f"token-after-{annotation_id}", "text": replacement, "origin": "base"}]
    return {
        "id": annotation_id,
        "start_token": start,
        "end_token": end,
        "replacement": replacement,
        "error_type_id": 1,
        "version": 1,
        "payload": {
            "operation": operation,
            "before_tokens": before,
            "after_tokens": after,
            "text_tokens": tokens,
        },
    }


def test_repair_overlap_uses_version_history_not_annotation_id():
    tokens = ["Alpha", "beta"]
    newer = legacy_annotation(10, 0, 0, "New", ["token-40"], tokens)
    older = legacy_annotation(20, 0, 0, "Old", ["token-40"], tokens)
    record = {
        "text_id": 1,
        "task_id": 1,
        "author_id": str(uuid.uuid4()),
        "source": "Alpha beta",
        "annotations": [newer, older],
        "annotation_history": {
            "10": [{"version": 1, "created_at": "2026-01-02T00:00:00+00:00"}],
            "20": [{"version": 1, "created_at": "2026-01-01T00:00:00+00:00"}],
        },
    }
    record["fingerprint"] = record_fingerprint(record["source"], record["annotations"])

    item = build_repair_bundle(repair_snapshot(record))["items"][0]

    assert [annotation["id"] for annotation in item["proposed_annotations"]] == [10]
    assert item["proposed_target"] == "New beta"


def test_repair_regression_move_followed_by_edits_targets_original_tokens():
    source = (
        "Үзем шулай вирустан котылдым КОВИДобесия вакытында. Эштә баш авырту һәм "
        "игътибарны туплый алмыйм, буыннар сызлый, температура күтәрелде, ис сизү "
        "югалды, Поликлиникага киттем, хастаханә кәгазен 10 көнгә бирделәр. Озак "
        "уйлап тормадым, өйдә алма серкәсен суга кушып эчтем."
    )
    tokens = [
        "Үзем", "шулай", "вирустан", "котылдым", "КОВИДобесия", "вакытында", ".",
        "Эштә", "баш", "авырту", "һәм", "игътибарны", "туплый", "алмыйм", ",",
        "буыннар", "сызлый", ",", "температура", "күтәрелде", ",", "ис", "сизү",
        "югалды", ",", "Поликлиникага", "киттем", ",", "хастаханә", "кәгазен", "10",
        "көнгә", "бирделәр", ".", "Озак", "уйлап", "тормадым", ",", "өйдә", "алма",
        "серкәсен", "суга", "кушып", "эчтем", ".",
    ]
    annotations = [
        legacy_annotation(125, 10, 10, "авыртты", ["token-491"], tokens),
        legacy_annotation(126, 14, 14, "алмадым", ["token-495"], tokens),
        legacy_annotation(127, 17, 17, "сызлады", ["token-498"], tokens),
        legacy_annotation(128, 25, 25, ".", ["token-506"], tokens),
        legacy_annotation(129, 1, 2, "КОВИДобесия вакытында", ["token-486", "token-487"], tokens, operation="move"),
    ]
    annotations[-1]["payload"]["after_tokens"] = [
        {"id": "token-486", "text": "КОВИДобесия", "origin": "base"},
        {"id": "token-487", "text": "вакытында", "origin": "base"},
    ]
    record = {
        "text_id": 520,
        "task_id": 520,
        "author_id": str(uuid.uuid4()),
        "source": source,
        "annotations": annotations,
        "annotation_history": {},
    }
    record["fingerprint"] = record_fingerprint(source, annotations)

    item = build_repair_bundle(repair_snapshot(record))["items"][0]

    assert item["proposed_target"] == (
        "Үзем КОВИДобесия вакытында шулай вирустан котылдым. Эштә баш авыртты һәм "
        "игътибарны туплый алмадым, буыннар сызлады, температура күтәрелде, ис сизү "
        "югалды. Поликлиникага киттем, хастаханә кәгазен 10 көнгә бирделәр. Озак "
        "уйлап тормадым, өйдә алма серкәсен суга кушып эчтем."
    )


def test_repair_regression_overlap_uses_contextual_spacing():
    source = "Кичке алтыдан иртәнге алтыга кадәр +дүрт сәгать.Була 16 сәгать ач торасың."
    tokens = [
        "Кичке", "алтыдан", "иртәнге", "алтыга", "кадәр", "+", "дүрт", "сәгать",
        ".", "Була", "16", "сәгать", "ач", "торасың", ".",
    ]
    partial = legacy_annotation(5303, 9, 9, "ула", ["token-31"], tokens)
    whole = legacy_annotation(5304, 8, 9, "була.", ["token-30", "token-31"], tokens)
    whole["version"] = 5
    whole["payload"]["after_tokens"][0]["space_before"] = False
    record = {
        "text_id": 1371,
        "task_id": 1371,
        "author_id": str(uuid.uuid4()),
        "source": source,
        "annotations": [partial, whole],
        "annotation_history": {},
    }
    record["fingerprint"] = record_fingerprint(source, record["annotations"])

    item = build_repair_bundle(repair_snapshot(record))["items"][0]

    assert [annotation["id"] for annotation in item["proposed_annotations"]] == [5304]
    assert item["proposed_target"] == "Кичке алтыдан иртәнге алтыга кадәр +дүрт сәгать була. 16 сәгать ач торасың."


def test_repair_replays_dynamic_coordinates_after_an_earlier_insertion():
    source = (
        "Ул бит сездән яман сүзләр сорамый жәмәгать.Башта аңлап бетерегез."
        "Кухняда намаз укырга ярыймы дип сорый.Нигә шуның кадәр ямьсез сүзләр "
        "бн кешегә пычырак атасыз."
    )
    tokens = [
        "Ул", "бит", "сездән", "яман", "сүзләр", "сорамый", "жәмәгать", ".",
        "Башта", "аңлап", "бетерегез", ".", "Кухняда", "намаз", "укырга",
        "ярыймы", "дип", "сорый", ".", "Нигә", "шуның", "кадәр", "ямьсез",
        "сүзләр", "бн", "кешегә", "пычырак", "атасыз", ".",
    ]
    annotations = [
        legacy_annotation(156, 6, 6, ",", [], tokens, operation="insert"),
        legacy_annotation(157, 27, 27, "пычрак", ["token-803"], tokens),
        legacy_annotation(158, 25, 25, "белән", ["token-801"], tokens),
        legacy_annotation(159, 29, 29, "?", ["token-805"], tokens),
    ]
    created = {
        156: "2025-12-09T20:57:56+03:00",
        157: "2025-12-09T20:58:40+03:00",
        158: "2025-12-09T20:58:50+03:00",
        159: "2025-12-09T20:59:09+03:00",
    }
    history = {
        str(annotation["id"]): [
            {
                "version": 1,
                "created_at": created[annotation["id"]],
                "snapshot": copy.deepcopy(annotation),
            }
        ]
        for annotation in annotations
    }
    record = {
        "text_id": 523,
        "task_id": 43,
        "author_id": str(uuid.uuid4()),
        "source": source,
        "annotations": annotations,
        "annotation_history": history,
    }
    record["fingerprint"] = record_fingerprint(source, annotations)

    item = build_repair_bundle(repair_snapshot(record))["items"][0]

    assert item["proposed_target"] == (
        "Ул бит сездән яман сүзләр сорамый, жәмәгать. Башта аңлап бетерегез. "
        "Кухняда намаз укырга ярыймы дип сорый. Нигә шуның кадәр ямьсез сүзләр "
        "белән кешегә пычрак атасыз?"
    )
    assert len(item["recovery_evidence"]["whitespace_normalization"]["changes"]) == 3
    assert "historical_coordinates_replayed" in item["risk"]
    assert "diff_reconstructed" not in item["risk"]


def test_stable_token_identity_overrides_a_reused_rows_creation_coordinate():
    tokens = ["A", "B", "C", "D", "E", "F"]
    reused = legacy_annotation(1, 5, 5, "X", ["token-104"], tokens)
    moved = legacy_annotation(2, 0, 0, "C", ["token-102"], tokens, operation="move")
    reused_creation = legacy_annotation(1, 5, 5, ",", [], tokens, operation="insert")
    record = {
        "text_id": 700,
        "task_id": 700,
        "author_id": str(uuid.uuid4()),
        "source": "A B C D E F",
        "annotations": [reused, moved],
        "annotation_history": {
            "1": [
                {
                    "version": 1,
                    "created_at": "2025-12-09T20:00:00+03:00",
                    "snapshot": reused_creation,
                }
            ],
            "2": [
                {
                    "version": 1,
                    "created_at": "2025-12-09T20:01:00+03:00",
                    "snapshot": moved,
                }
            ],
        },
    }
    record["fingerprint"] = record_fingerprint(record["source"], record["annotations"])

    item = build_repair_bundle(repair_snapshot(record))["items"][0]
    replacement = next(
        annotation for annotation in item["proposed_annotations"] if annotation["id"] == 1
    )

    assert replacement["start_token"] == 4
    assert replacement["payload"]["before_tokens"] == ["base-4"]
    assert "row_identity_reused" in item["risk"]
    assert item["confidence"] == "low"


def test_repair_reconstructs_invalid_legacy_coordinates_as_canonical_diff():
    tokens = ["Alpha", "beta"]
    annotation = legacy_annotation(90, 4, 4, "gamma", ["token-44"], tokens)
    record = {
        "text_id": 90,
        "task_id": 90,
        "author_id": str(uuid.uuid4()),
        "source": "Alpha beta",
        "annotations": [annotation],
        "annotation_history": {},
    }
    record["fingerprint"] = record_fingerprint(record["source"], record["annotations"])

    item = build_repair_bundle(repair_snapshot(record))["items"][0]

    assert item["confidence"] == "low"
    assert "diff_reconstructed" in item["risk"]
    assert len(item["risk"]) <= 128
    assert not any(annotation["id"] for annotation in item["proposed_annotations"])
    for proposal in item["proposed_annotations"]:
        validate_canonical_annotation_payload(
            proposal["payload"],
            start_token=proposal["start_token"],
            end_token=proposal["end_token"],
            token_count=len(proposal["payload"]["text_tokens"]),
        )
