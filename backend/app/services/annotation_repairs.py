"""Deterministic snapshot, proposal, review-manifest, and apply helpers."""

from __future__ import annotations

import copy
import difflib
import hashlib
import json
import re
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Iterable

from sqlalchemy.orm import Session

from ..models import (
    Annotation,
    AnnotationRepairApplication,
    AnnotationRepairBatch,
    AnnotationRepairItem,
    AnnotationRepairProposalRevision,
    AnnotationTask,
    AnnotationVersion,
    ErrorType,
    TextSample,
)
from .annotation_payloads import AnnotationPayloadError, validate_canonical_annotation_payload
from .m2_export import M2ExportError, build_m2_export
from .annotation_rendering import (
    build_tokens_from_fragments,
    is_punct_only,
    is_special_token,
    render_corrected_text,
    tokenize_to_tokens,
)
from .annotation_saves import sha256_text, sha256_tokens


class AnnotationRepairError(ValueError):
    """Raised when a repair artifact or database precondition is invalid."""


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def content_hash(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _recovery_evidence_hash(evidence: dict[str, object]) -> str:
    projection_keys = {
        "backend_restored_target",
        "backend_restored_target_sha256",
        "frontend_restored_target",
        "frontend_restored_target_sha256",
        "projection_mismatch",
        "whitespace_normalization",
    }
    return content_hash(
        {
            key: value
            for key, value in evidence.items()
            if key != "evidence_hash" and key not in projection_keys
        }
    )


_CLOSING_PUNCTUATION = {".", ",", ";", ":", "?", "!"}
_NUMERIC_SEPARATORS = {".", ",", ":"}


def normalize_punctuation_spacing(text: str) -> tuple[str, dict[str, object]]:
    """Normalize only high-confidence spacing around closing punctuation."""
    changes: list[dict[str, object]] = []
    skipped: list[dict[str, object]] = []
    pattern = re.compile(r"(?P<before>[^\S\r\n]*)(?P<punct>[.,;:?!])(?P<after>[^\S\r\n]*)")

    def replace(match: re.Match[str]) -> str:
        punctuation = match.group("punct")
        before = match.group("before")
        after = match.group("after")
        punct_offset = match.start("punct")
        line_start = text.rfind("\n", 0, punct_offset) + 1
        if line_start > 0 and not text[line_start:punct_offset].strip():
            skipped.append(
                {
                    "rule": "preserve_line_start_punctuation",
                    "character_offset": punct_offset,
                    "punctuation": punctuation,
                }
            )
            return match.group(0)
        chunk_start = punct_offset
        while chunk_start > 0 and not text[chunk_start - 1].isspace():
            chunk_start -= 1
        chunk_end = punct_offset + 1
        while chunk_end < len(text) and not text[chunk_end].isspace():
            chunk_end += 1
        chunk = text[chunk_start:chunk_end]
        if is_special_token(chunk) or re.search(r"(?:https?://|www\.)", chunk):
            return match.group(0)

        previous = text[match.start() - 1] if match.start() else ""
        next_offset = match.end()
        following = text[next_offset] if next_offset < len(text) else ""
        desired_before = ""
        desired_after = after
        after_rule: str | None = None

        if not following or following in "\r\n":
            desired_after = after
        elif is_punct_only(following):
            desired_after = ""
            after_rule = "compact_punctuation_sequence"
        elif (
            punctuation in _NUMERIC_SEPARATORS
            and previous.isdigit()
            and following.isdigit()
        ):
            desired_after = ""
            after_rule = "compact_numeric_separator"
        else:
            previous_word = re.search(r"([^\W\d_]+)$", text[: match.start()])
            if (
                punctuation == "."
                and previous_word
                and len(previous_word.group(1)) == 1
                and not after
            ):
                skipped.append(
                    {
                        "rule": "preserve_possible_abbreviation",
                        "character_offset": punct_offset,
                        "punctuation": punctuation,
                    }
                )
            else:
                desired_after = " "
                after_rule = "separate_after_closing_punctuation"

        if before:
            changes.append(
                {
                    "rule": "attach_closing_punctuation",
                    "character_offset": punct_offset,
                    "punctuation": punctuation,
                    "before": before,
                    "after": "",
                }
            )
        if desired_after != after and after_rule:
            changes.append(
                {
                    "rule": after_rule,
                    "character_offset": punct_offset + 1,
                    "punctuation": punctuation,
                    "before": after,
                    "after": desired_after,
                }
            )
        return f"{desired_before}{punctuation}{desired_after}"

    normalized = pattern.sub(replace, text)
    return normalized, {
        "version": 1,
        "status": "applied" if changes else "unchanged",
        "input_sha256": sha256_text(text),
        "output_sha256": sha256_text(normalized),
        "changes": changes,
        "skipped": skipped,
    }


def annotation_snapshot(annotation: Annotation) -> dict[str, object]:
    return {
        "id": annotation.id,
        "author_id": str(annotation.author_id),
        "start_token": annotation.start_token,
        "end_token": annotation.end_token,
        "replacement": annotation.replacement,
        "error_type_id": annotation.error_type_id,
        "payload": copy.deepcopy(annotation.payload or {}),
        "version": annotation.version,
    }


def record_fingerprint(source: str, annotations: Iterable[dict[str, object]]) -> str:
    rows = sorted(
        (copy.deepcopy(item) for item in annotations), key=lambda item: int(item.get("id") or 0)
    )
    return content_hash({"source_sha256": sha256_text(source), "annotations": rows})


def export_repair_snapshot(db: Session, category_id: int) -> dict[str, object]:
    tasks = (
        db.query(AnnotationTask)
        .join(TextSample, AnnotationTask.text_id == TextSample.id)
        .filter(TextSample.category_id == category_id, AnnotationTask.status == "submitted")
        .order_by(AnnotationTask.updated_at.desc(), AnnotationTask.id.desc())
        .all()
    )
    selected: dict[int, AnnotationTask] = {}
    for task in tasks:
        selected.setdefault(task.text_id, task)

    records: list[dict[str, object]] = []
    for text_id in sorted(selected):
        task = selected[text_id]
        text = db.get(TextSample, text_id)
        if text is None:
            continue
        annotations = (
            db.query(Annotation)
            .filter(Annotation.text_id == text_id, Annotation.author_id == task.annotator_id)
            .order_by(Annotation.id)
            .all()
        )
        rows = [annotation_snapshot(annotation) for annotation in annotations]
        approval_rows: list[dict[str, object]] = []
        selected_versions: list[dict[str, object]] = []
        excluded_after_submission: list[int] = []
        post_submission_version_count = 0
        annotation_ids = [annotation.id for annotation in annotations]
        histories: dict[str, list[dict[str, object]]] = defaultdict(list)
        versions_by_annotation: dict[int, list[AnnotationVersion]] = defaultdict(list)
        if annotation_ids:
            versions = (
                db.query(AnnotationVersion)
                .filter(AnnotationVersion.annotation_id.in_(annotation_ids))
                .order_by(AnnotationVersion.created_at, AnnotationVersion.id)
                .all()
            )
            for version in versions:
                versions_by_annotation[version.annotation_id].append(version)
                histories[str(version.annotation_id)].append(
                    {
                        "version": version.version,
                        "snapshot": copy.deepcopy(version.snapshot),
                        "created_at": version.created_at.isoformat()
                        if version.created_at
                        else None,
                    }
                )
        for annotation in annotations:
            annotation_versions = versions_by_annotation.get(annotation.id, [])
            before_versions = [
                version
                for version in annotation_versions
                if version.created_at and version.created_at <= task.updated_at
            ]
            before_submission = before_versions[-1] if before_versions else None
            post_submission_version_count += sum(
                1
                for version in annotation_versions
                if version.created_at and version.created_at > task.updated_at
            )
            if before_submission:
                restored = copy.deepcopy(before_submission.snapshot)
                restored.update(
                    id=annotation.id,
                    author_id=str(annotation.author_id),
                    version=before_submission.version,
                )
                approval_rows.append(restored)
                selected_versions.append(
                    {
                        "annotation_id": annotation.id,
                        "annotation_version_id": before_submission.id,
                        "version": before_submission.version,
                        "created_at": (
                            before_submission.created_at.isoformat()
                            if before_submission.created_at
                            else None
                        ),
                    }
                )
            elif annotation.created_at and annotation.created_at <= task.updated_at:
                approval_rows.append(annotation_snapshot(annotation))
                selected_versions.append(
                    {
                        "annotation_id": annotation.id,
                        "annotation_version_id": None,
                        "version": annotation.version,
                        "created_at": annotation.created_at.isoformat(),
                        "fallback": "current_row_without_version",
                    }
                )
            else:
                excluded_after_submission.append(annotation.id)

        uncertain = bool(post_submission_version_count or excluded_after_submission)
        evidence = {
            "method": "latest-version-at-or-before-submission",
            "submitted_at": task.updated_at.isoformat() if task.updated_at else None,
            "selected_versions": selected_versions,
            "excluded_after_submission_ids": excluded_after_submission,
            "post_submission_version_count": post_submission_version_count,
            "possible_deleted_rows": uncertain,
            "confidence": "uncertain" if uncertain else "complete",
        }
        evidence["evidence_hash"] = content_hash(evidence)
        records.append(
            {
                "text_id": text.id,
                "task_id": task.id,
                "author_id": str(task.annotator_id),
                "task_updated_at": task.updated_at.isoformat() if task.updated_at else None,
                "source": text.content or "",
                "source_sha256": sha256_text(text.content or ""),
                "annotations": rows,
                "approval_annotations": approval_rows,
                "annotation_history": dict(histories),
                "recovery_evidence": evidence,
                "fingerprint": record_fingerprint(text.content or "", rows),
            }
        )
    body: dict[str, object] = {
        "format": "annotation-repair-snapshot-v2",
        "category_id": category_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "records": records,
    }
    body["snapshot_hash"] = content_hash(
        {key: value for key, value in body.items() if key != "created_at"}
    )
    return body


def _legacy_token_number(token_id: object) -> int | None:
    match = re.fullmatch(r"token-(\d+)", str(token_id))
    return int(match.group(1)) if match else None


def _after_texts(annotation: dict[str, object]) -> list[str]:
    payload = annotation.get("payload") or {}
    return [
        str(item.get("text") or "")
        for item in payload.get("after_tokens") or []
        if isinstance(item, dict)
    ]


def _unique_sequence_index(source: list[str], expected: list[str]) -> int | None:
    if not expected:
        return None
    folded_source = [item.casefold() for item in source]
    folded_expected = [item.casefold() for item in expected]
    matches = [
        index
        for index in range(0, len(source) - len(expected) + 1)
        if folded_source[index : index + len(expected)] == folded_expected
    ]
    return matches[0] if len(matches) == 1 else None


def _annotation_updated_key(
    annotation: dict[str, object], history: dict[str, list[dict[str, object]]]
) -> tuple:
    versions = history.get(str(annotation.get("id"))) or []
    last_created = versions[-1].get("created_at") if versions else ""
    return (
        str(last_created or ""),
        int(annotation.get("version") or 0),
        int(annotation.get("id") or 0),
    )


def _legacy_creation_coordinate_map(
    annotations: list[dict[str, object]],
    history: dict[str, list[dict[str, object]]],
    token_count: int,
) -> dict[int, int]:
    """Replay historical editor lengths to map dynamic card positions to source positions."""
    virtual: list[list[int]] = [[index] for index in range(token_count)]
    mapped: dict[int, int] = {}
    creations: list[tuple[str, int, dict[str, object]]] = []
    for annotation in annotations:
        annotation_id = int(annotation.get("id") or 0)
        versions = history.get(str(annotation_id)) or []
        if not versions:
            continue
        first = versions[0]
        creations.append(
            (str(first.get("created_at") or ""), annotation_id, first.get("snapshot") or {})
        )

    for _, annotation_id, snapshot in sorted(creations):
        payload = snapshot.get("payload") or {}
        operation = str(payload.get("operation") or "")
        if operation == "move":
            # Moves need their explicit source identities and coordinates; replaying only their
            # destination length would make later positions less reliable.
            break
        start = int(snapshot.get("start_token") or 0)
        start = max(0, min(start, len(virtual)))
        before_count = len(payload.get("before_tokens") or [])
        after_count = len(payload.get("after_tokens") or [])

        if operation == "insert":
            source_anchor = next(
                (entry[0] for entry in virtual[start:] if entry),
                token_count,
            )
            mapped[annotation_id] = source_anchor
            virtual[start:start] = [[] for _ in range(max(1, after_count))]
            continue
        if operation == "noop" or before_count == 0 or start >= len(virtual):
            continue

        consumed = 0
        stop = start
        source_indices: list[int] = []
        while stop < len(virtual) and consumed < before_count:
            source_indices.extend(virtual[stop])
            consumed += len(virtual[stop])
            stop += 1
        if consumed != before_count or not source_indices:
            continue
        mapped[annotation_id] = source_indices[0]
        output_count = 1 if operation == "delete" else max(1, after_count)
        replacement = [source_indices] + [[] for _ in range(output_count - 1)]
        virtual[start:stop] = replacement
    return mapped


def _overlap_components(
    annotations: list[dict[str, object]], history: dict[str, list[dict[str, object]]]
) -> tuple[list[dict[str, object]], bool]:
    """Keep the latest non-move correction in each overlapping legacy component."""
    moves = [item for item in annotations if (item.get("payload") or {}).get("operation") == "move"]
    nonmoves = [
        item for item in annotations if (item.get("payload") or {}).get("operation") != "move"
    ]
    kept: list[dict[str, object]] = []
    had_overlap = False
    remaining = list(nonmoves)
    while remaining:
        component = [remaining.pop(0)]
        changed = True
        while changed:
            changed = False
            component_ids = {
                str(token)
                for item in component
                for token in ((item.get("payload") or {}).get("before_tokens") or [])
            }
            for candidate in list(remaining):
                candidate_ids = {
                    str(token)
                    for token in ((candidate.get("payload") or {}).get("before_tokens") or [])
                }
                if component_ids and candidate_ids and component_ids.intersection(candidate_ids):
                    component.append(candidate)
                    remaining.remove(candidate)
                    changed = True
        if len(component) > 1:
            had_overlap = True
        kept.append(max(component, key=lambda item: _annotation_updated_key(item, history)))
    return moves + kept, had_overlap


def _normalize_candidate_annotations(
    record: dict[str, object],
) -> tuple[list[dict[str, object]], str, str, str]:
    source = str(record["source"])
    original = [copy.deepcopy(item) for item in record.get("annotations") or []]
    history = record.get("annotation_history") or {}
    source_tokens = []
    for annotation in original:
        tokens = (annotation.get("payload") or {}).get("text_tokens") or []
        if tokens:
            source_tokens = [str(token) for token in tokens]
            break
    if not source_tokens:
        source_tokens = source.split()
    source_token_details = tokenize_to_tokens(source)

    creation_coordinates = _legacy_creation_coordinate_map(
        original,
        history,
        len(source_tokens),
    )
    coordinates_replayed = any(
        creation_coordinates.get(int(annotation.get("id") or 0))
        != int(annotation.get("start_token") or 0)
        for annotation in original
        if int(annotation.get("id") or 0) in creation_coordinates
    )
    row_identity_reused = any(
        bool(history.get(str(annotation.get("id"))))
        and (
            str(
                (
                    (history[str(annotation.get("id"))][0].get("snapshot") or {}).get("payload")
                    or {}
                ).get("operation")
                or ""
            )
            != str((annotation.get("payload") or {}).get("operation") or "")
            or [
                str(token)
                for token in (
                    (
                        (history[str(annotation.get("id"))][0].get("snapshot") or {}).get("payload")
                        or {}
                    ).get("before_tokens")
                    or []
                )
            ]
            != [
                str(token)
                for token in ((annotation.get("payload") or {}).get("before_tokens") or [])
            ]
        )
        for annotation in original
    )

    anchor_offsets: set[int] = set()
    unique_move_sources: dict[int, int] = {}
    for annotation in original:
        payload = annotation.get("payload") or {}
        before = payload.get("before_tokens") or []
        numbers = [_legacy_token_number(token) for token in before]
        if not numbers or any(number is None for number in numbers):
            continue
        operation = payload.get("operation")
        move_from = payload.get("move_from", payload.get("moveFrom"))
        if operation == "move":
            unique_source = _unique_sequence_index(source_tokens, _after_texts(annotation))
            if unique_source is not None:
                unique_move_sources[int(annotation.get("id") or 0)] = unique_source
                anchor_offsets.add(int(numbers[0]) - unique_source)
            if isinstance(move_from, int):
                anchor_offsets.add(int(numbers[0]) - move_from)

    selected, had_overlap = _overlap_components(original, history)
    selected.sort(key=lambda item: _annotation_updated_key(item, history))
    normalized: list[dict[str, object]] = []
    ambiguous = False
    inferred_move = False
    for annotation in selected:
        payload = copy.deepcopy(annotation.get("payload") or {})
        operation = str(
            payload.get("operation") or ("replace" if annotation.get("replacement") else "noop")
        )
        before = [str(token) for token in payload.get("before_tokens") or []]
        numbers = [_legacy_token_number(token) for token in before]
        annotation_id = int(annotation.get("id") or 0)
        mapped_start: int | None = creation_coordinates.get(annotation_id)
        if before and all(number is not None for number in numbers):
            candidates = {
                int(numbers[0]) - offset
                for offset in anchor_offsets
                if 0 <= int(numbers[0]) - offset < len(source_tokens)
            }
            if len(candidates) == 1:
                mapped_start = candidates.pop()
            elif mapped_start is not None:
                pass
            elif operation == "move" and int(annotation.get("id") or 0) in unique_move_sources:
                mapped_start = unique_move_sources[int(annotation.get("id") or 0)]
                inferred_move = not isinstance(payload.get("move_from"), int)
            elif operation == "move" and isinstance(payload.get("move_from"), int):
                mapped_start = int(payload["move_from"])
            elif operation != "insert":
                mapped_start = int(annotation.get("start_token") or 0)
                if len(candidates) > 1:
                    ambiguous = True

        normalized_payload = payload
        normalized_payload["schema_version"] = 2
        normalized_payload["client_correction_id"] = f"repair-{annotation_id}"
        normalized_payload["source"] = "repair"
        normalized_payload["text_sha256"] = sha256_text(source)
        normalized_payload["text_tokens"] = source_tokens
        normalized_payload["text_tokens_sha256"] = sha256_tokens(source_tokens)
        if mapped_start is not None and before:
            normalized_payload["before_tokens"] = [
                f"base-{mapped_start + index}" for index in range(len(before))
            ]
        elif operation == "noop":
            normalized_payload["before_tokens"] = []

        after_tokens = []
        for index, fragment in enumerate(payload.get("after_tokens") or []):
            if not isinstance(fragment, dict):
                fragment = {"text": str(fragment), "origin": "base"}
            normalized_fragment = copy.deepcopy(fragment)
            normalized_fragment["id"] = f"repair-{annotation_id}-{index}"
            if index == 0 and operation in {"replace", "delete"}:
                # Legacy fragments captured absolute spacing before later moves changed context.
                normalized_fragment.pop("space_before", None)
                normalized_fragment.pop("spaceBefore", None)
                source_token = (
                    source_tokens[mapped_start]
                    if mapped_start is not None and 0 <= mapped_start < len(source_tokens)
                    else ""
                )
                if (
                    operation == "replace"
                    and mapped_start is not None
                    and mapped_start > 0
                    and is_punct_only(source_token)
                    and not is_punct_only(str(normalized_fragment.get("text") or ""))
                ):
                    normalized_fragment["space_before"] = True
            if (
                index == 0
                and operation == "insert"
                and is_punct_only(str(normalized_fragment.get("text") or ""))
            ):
                normalized_fragment["space_before"] = False
            after_tokens.append(normalized_fragment)
        normalized_payload["after_tokens"] = after_tokens

        start_token = int(annotation.get("start_token") or 0)
        end_token = int(annotation.get("end_token") or start_token)
        if operation == "move":
            move_len = len(before) or len(after_tokens) or 1
            if mapped_start is None:
                mapped_start = int(payload.get("move_from", start_token))
                ambiguous = True
            move_to = payload.get("move_to", payload.get("moveTo"))
            if not isinstance(move_to, int):
                move_to = start_token
                inferred_move = True
            normalized_payload.update(move_from=mapped_start, move_to=move_to, move_len=move_len)
            if after_tokens and 0 <= mapped_start < len(source_token_details):
                after_tokens[0]["space_before"] = bool(
                    source_token_details[mapped_start].get("space_before")
                )
            start_token = move_to
            end_token = move_to + move_len - 1
        elif operation in {"replace", "delete"} and mapped_start is not None:
            start_token = mapped_start
            end_token = mapped_start + max(0, len(before) - 1)
        elif operation == "insert" and mapped_start is not None:
            start_token = end_token = mapped_start
        elif operation == "noop":
            start_token = end_token = -1

        normalized.append(
            {
                "id": annotation.get("id"),
                "start_token": start_token,
                "end_token": end_token,
                "replacement": annotation.get("replacement"),
                "error_type_id": annotation.get("error_type_id"),
                "payload": normalized_payload,
                "version": annotation.get("version", 1),
            }
        )

    risk_parts = ["legacy_ids"]
    if had_overlap:
        risk_parts.append("overlap_superseded")
    if inferred_move:
        risk_parts.append("move_inferred")
    if ambiguous:
        risk_parts.append("ambiguous_mapping")
    if coordinates_replayed:
        risk_parts.append("historical_coordinates_replayed")
    if row_identity_reused:
        risk_parts.append("row_identity_reused")
    confidence = (
        "low"
        if ambiguous or row_identity_reused
        else "medium"
        if had_overlap or inferred_move or coordinates_replayed
        else "high"
    )
    explanation = ", ".join(risk_parts)
    return normalized, confidence, "+".join(risk_parts), explanation


def _render(source: str, annotations: list[dict[str, object]]) -> str:
    return render_corrected_text(
        source, [SimpleNamespace(**annotation) for annotation in annotations]
    )


def _canonical_errors(annotations: list[dict[str, object]]) -> list[str]:
    errors: list[str] = []
    for annotation in annotations:
        payload = annotation.get("payload") or {}
        try:
            validate_canonical_annotation_payload(
                payload,
                start_token=int(annotation.get("start_token") or 0),
                end_token=int(annotation.get("end_token") or 0),
                token_count=len(payload.get("text_tokens") or []),
            )
        except AnnotationPayloadError as exc:
            errors.append(f"annotation {annotation.get('id')}: {exc}")
    return errors


def _nearest_error_type(
    annotations: list[dict[str, object]],
    source_start: int,
    source_end: int,
    target_texts: list[str],
) -> int | None:
    target_words = {text.casefold() for text in target_texts if text}

    def score(annotation: dict[str, object]) -> tuple[int, int, int]:
        start = int(annotation.get("start_token") or 0)
        end = int(annotation.get("end_token") or start)
        replacement_words = {text.casefold() for text in _after_texts(annotation) if text}
        text_match = 0 if target_words.intersection(replacement_words) else 1
        overlap = not (end < source_start or start >= source_end)
        distance = 0 if overlap else min(abs(start - source_start), abs(end - source_start))
        return (text_match, distance, int(annotation.get("id") or 0))

    labeled = [
        annotation for annotation in annotations if annotation.get("error_type_id") is not None
    ]
    if not labeled:
        return None
    return min(labeled, key=score).get("error_type_id")


def _token_keys(tokens: list[dict[str, object]]) -> list[tuple[str, bool]]:
    return [(str(token.get("text") or ""), bool(token.get("space_before"))) for token in tokens]


def _matching_error_type(
    annotations: list[dict[str, object]],
    operation: str,
    source_start: int,
    source_end: int,
    target_tokens: list[dict[str, object]],
) -> int | None:
    expected_before = [f"base-{index}" for index in range(source_start, source_end)]
    expected_start = source_start
    expected_end = source_start if operation == "insert" else source_end - 1
    expected_target = _token_keys(target_tokens)
    for annotation in annotations:
        payload = annotation.get("payload") or {}
        if payload.get("label_needs_review") is True:
            continue
        if payload.get("operation") != operation:
            continue
        if int(annotation.get("start_token") or 0) != expected_start:
            continue
        if int(annotation.get("end_token") or 0) != expected_end:
            continue
        if [str(token) for token in payload.get("before_tokens") or []] != expected_before:
            continue
        fragments = [
            fragment if isinstance(fragment, dict) else {"text": str(fragment)}
            for fragment in payload.get("after_tokens") or []
        ]
        prior_target = build_tokens_from_fragments(
            fragments,
            str(annotation.get("replacement") or ""),
            bool(target_tokens[0].get("space_before")) if target_tokens else None,
        )
        if _token_keys(prior_target) == expected_target:
            error_type_id = annotation.get("error_type_id")
            return int(error_type_id) if error_type_id is not None else None
    return None


def _reconstruct_canonical_diff(
    source: str,
    target: str,
    prior_annotations: list[dict[str, object]],
    text_id: int,
    *,
    require_changed_label_review: bool = False,
    spacing_error_type_id: int | None = None,
) -> list[dict[str, object]]:
    source_tokens = tokenize_to_tokens(source)
    target_tokens = tokenize_to_tokens(target)
    source_texts = [str(token["text"]) for token in source_tokens]
    target_texts = [str(token["text"]) for token in target_tokens]
    source_keys = [(str(token["text"]), bool(token.get("space_before"))) for token in source_tokens]
    target_keys = [(str(token["text"]), bool(token.get("space_before"))) for token in target_tokens]
    matcher = difflib.SequenceMatcher(a=source_keys, b=target_keys, autojunk=False)
    reconstructed: list[dict[str, object]] = []
    for index, (tag, source_start, source_end, target_start, target_end) in enumerate(
        matcher.get_opcodes()
    ):
        if tag == "equal":
            continue
        operation = "insert" if tag == "insert" else "delete" if tag == "delete" else "replace"
        fragments: list[dict[str, object]] = []
        for token in target_tokens[target_start:target_end]:
            token_text = str(token["text"])
            if fragments and token.get("space_before") is False:
                fragments[-1]["text"] = f"{fragments[-1]['text']}{token_text}"
                continue
            fragments.append(
                {
                    "id": f"repair-diff-{text_id}-{index}-{len(fragments)}",
                    "text": token_text,
                    "origin": "inserted" if operation == "insert" else "base",
                    "space_before": bool(token.get("space_before")),
                }
            )
        before = [f"base-{token_index}" for token_index in range(source_start, source_end)]
        start_token = source_start
        end_token = source_start if operation == "insert" else source_end - 1
        replacement = " ".join(fragment["text"] for fragment in fragments) or None
        exact_error_type = _matching_error_type(
            prior_annotations,
            operation,
            source_start,
            source_end,
            target_tokens[target_start:target_end],
        )
        spacing_only = (
            source_texts[source_start:source_end] == target_texts[target_start:target_end]
        )
        if exact_error_type is not None:
            error_type_id = exact_error_type
        elif spacing_error_type_id is not None and spacing_only:
            error_type_id = spacing_error_type_id
        else:
            error_type_id = _nearest_error_type(
                prior_annotations,
                source_start,
                max(source_start + 1, source_end),
                target_texts[target_start:target_end],
            )
        needs_label_review = (
            require_changed_label_review
            and exact_error_type is None
            and not (spacing_error_type_id is not None and spacing_only)
        )
        detail_payload: dict[str, object] = {
            "schema_version": 2,
            "client_correction_id": f"repair-diff-{text_id}-{index}",
            "operation": operation,
            "before_tokens": before,
            "after_tokens": fragments,
            "text_sha256": sha256_text(source),
            "text_tokens": source_texts,
            "text_tokens_sha256": sha256_tokens(source_texts),
            "source": (
                "repair-spacing"
                if spacing_error_type_id is not None and spacing_only
                else "repair-manual"
                if require_changed_label_review
                else "repair-diff"
            ),
        }
        if needs_label_review:
            detail_payload["label_needs_review"] = True
        reconstructed.append(
            {
                "id": None,
                "start_token": start_token,
                "end_token": end_token,
                "replacement": replacement,
                "error_type_id": error_type_id,
                "payload": detail_payload,
                "version": 1,
            }
        )
    errors = _canonical_errors(reconstructed)
    rendered = _render(source, reconstructed)
    if errors or rendered != target:
        detail = "; ".join(errors) if errors else f"rendered target changed to {rendered!r}"
        raise AnnotationRepairError(
            f"Could not reconstruct canonical diff for text {text_id}: {detail}"
        )
    return reconstructed


def build_repair_bundle(
    snapshot: dict[str, object],
    previous_manifest: dict[str, object] | None = None,
    frontend_projections: dict[int, str] | None = None,
    target_overrides: dict[int, str] | None = None,
    *,
    require_frontend_projection: bool = False,
) -> dict[str, object]:
    snapshot_format = snapshot.get("format")
    if snapshot_format not in {"annotation-repair-snapshot-v1", "annotation-repair-snapshot-v2"}:
        raise AnnotationRepairError("Unsupported repair snapshot format")
    expected_hash = content_hash(
        {
            key: value
            for key, value in snapshot.items()
            if key not in {"created_at", "snapshot_hash"}
        }
    )
    if snapshot.get("snapshot_hash") != expected_hash:
        raise AnnotationRepairError("Repair snapshot hash does not match its content")

    previous_by_key: dict[tuple[int, int], dict[str, object]] = {}
    if previous_manifest:
        previous_format = previous_manifest.get("format")
        if previous_format == "annotation-repair-review-state-v1":
            expected_previous_hash = content_hash(
                {
                    key: value
                    for key, value in previous_manifest.items()
                    if key != "review_state_hash"
                }
            )
            if previous_manifest.get("review_state_hash") != expected_previous_hash:
                raise AnnotationRepairError("Repair review-state hash does not match its content")
        elif previous_format in {
            "annotation-repair-manifest-v1",
            "annotation-repair-manifest-v2",
        }:
            expected_previous_hash = content_hash(
                {
                    key: value
                    for key, value in previous_manifest.items()
                    if key != "manifest_hash"
                }
            )
            if previous_manifest.get("manifest_hash") != expected_previous_hash:
                raise AnnotationRepairError("Repair manifest hash does not match its content")
        else:
            raise AnnotationRepairError("Unsupported previous repair artifact format")
        previous_by_key = {
            (int(item["text_id"]), int(item["task_id"])): item
            for item in previous_manifest.get("items") or []
        }

    items: list[dict[str, object]] = []
    for record in snapshot.get("records") or []:
        source = str(record["source"])
        current = _render(source, record.get("annotations") or [])
        recovery_evidence = copy.deepcopy(record.get("recovery_evidence") or {})
        if snapshot_format == "annotation-repair-snapshot-v2":
            expected_evidence_hash = _recovery_evidence_hash(recovery_evidence)
            if recovery_evidence.get("evidence_hash") != expected_evidence_hash:
                raise AnnotationRepairError(
                    f"Recovery evidence hash does not match for text {record.get('text_id')}"
                )
        else:
            recovery_evidence = {
                "method": "legacy-current-row",
                "confidence": "legacy",
                "possible_deleted_rows": True,
            }
            recovery_evidence["evidence_hash"] = content_hash(recovery_evidence)

        approval_record = copy.deepcopy(record)
        approval_record["annotations"] = copy.deepcopy(
            record.get("approval_annotations", record.get("annotations")) or []
        )
        submitted_at = str(record.get("task_updated_at") or "")
        if submitted_at:
            approval_record["annotation_history"] = {
                annotation_id: [
                    entry
                    for entry in entries
                    if not entry.get("created_at") or str(entry["created_at"]) <= submitted_at
                ]
                for annotation_id, entries in (record.get("annotation_history") or {}).items()
            }
        backend_restored = _render(source, approval_record["annotations"])
        frontend_restored = (frontend_projections or {}).get(int(record["text_id"]))
        if require_frontend_projection and frontend_restored is None:
            raise AnnotationRepairError(
                f"Frontend approval-time projection is missing for text {record['text_id']}"
            )
        projection_mismatch = (
            frontend_restored is not None and frontend_restored != backend_restored
        )
        recovery_evidence["backend_restored_target_sha256"] = sha256_text(backend_restored)
        recovery_evidence["backend_restored_target"] = (
            backend_restored if projection_mismatch else None
        )
        recovery_evidence["frontend_restored_target"] = (
            frontend_restored if projection_mismatch else None
        )
        recovery_evidence["frontend_restored_target_sha256"] = (
            sha256_text(frontend_restored) if frontend_restored is not None else None
        )
        recovery_evidence["projection_mismatch"] = projection_mismatch
        previous = previous_by_key.get((int(record["text_id"]), int(record["task_id"])))
        preserve_approval = bool(
            previous
            and previous.get("status") == "approved"
            and previous.get("proposed_target") is not None
            and previous.get("proposed_annotations") is not None
        )
        proposed_annotations, confidence, risk, explanation = _normalize_candidate_annotations(
            approval_record
        )
        proposed = _render(source, proposed_annotations)
        if projection_mismatch:
            confidence = "low"
            risk = f"{risk}+frontend_backend_mismatch"
            explanation = f"{explanation}, frontend_backend_mismatch"
        restored = proposed
        canonical_errors = _canonical_errors(proposed_annotations)
        if canonical_errors:
            proposed_annotations = _reconstruct_canonical_diff(
                source,
                proposed,
                proposed_annotations,
                int(record["text_id"]),
            )
            confidence = "low"
            risk = f"{risk}+diff_reconstructed"
            explanation = f"{explanation}, diff_reconstructed"
        reviewer_target = (target_overrides or {}).get(int(record["text_id"]))
        if reviewer_target is not None:
            proposed = reviewer_target.replace("\r\n", "\n").replace("\r", "\n")
            proposed_annotations = _reconstruct_canonical_diff(
                source,
                proposed,
                proposed_annotations,
                int(record["text_id"]),
                require_changed_label_review=True,
            )
            confidence = "low"
            risk = f"{risk}+reviewer_target"
            explanation = f"{explanation}, reviewer_target"
        if preserve_approval:
            if (
                previous.get("source_sha256") != sha256_text(source)
                or previous.get("original_fingerprint") != record["fingerprint"]
            ):
                raise AnnotationRepairError(
                    f"Approved source state changed for text {record['text_id']}"
                )
            preserved_annotations = copy.deepcopy(previous["proposed_annotations"])
            preserved_target = str(previous["proposed_target"])
            errors = _canonical_errors(preserved_annotations)
            if errors or _render(source, preserved_annotations) != preserved_target:
                raise AnnotationRepairError(
                    f"Approved proposal is no longer valid for text {record['text_id']}"
                )
            proposed_annotations = preserved_annotations
            proposed = preserved_target
            confidence = str(previous.get("confidence") or confidence)
            risk = str(previous.get("risk") or risk)
            explanation = str(previous.get("explanation") or explanation)
        if preserve_approval:
            whitespace_audit: dict[str, object] = {
                "version": 1,
                "status": "skipped_approved",
                "input_sha256": sha256_text(proposed),
                "output_sha256": sha256_text(proposed),
                "changes": [],
                "skipped": [],
            }
        elif reviewer_target is not None:
            whitespace_audit = {
                "version": 1,
                "status": "skipped_reviewer_target",
                "input_sha256": sha256_text(proposed),
                "output_sha256": sha256_text(proposed),
                "changes": [],
                "skipped": [],
            }
        else:
            normalized_target, whitespace_audit = normalize_punctuation_spacing(proposed)
            if normalized_target != proposed:
                try:
                    normalized_annotations = _reconstruct_canonical_diff(
                        source,
                        normalized_target,
                        proposed_annotations,
                        int(record["text_id"]),
                        require_changed_label_review=True,
                        spacing_error_type_id=4,
                    )
                except AnnotationRepairError as exc:
                    whitespace_audit["status"] = "skipped_unrepresentable"
                    whitespace_audit["output_sha256"] = whitespace_audit["input_sha256"]
                    whitespace_audit["attempted_changes"] = whitespace_audit.pop("changes")
                    whitespace_audit["changes"] = []
                    whitespace_audit["skipped"] = [
                        *(whitespace_audit.get("skipped") or []),
                        {"rule": "canonical_round_trip_failed", "reason": str(exc)},
                    ]
                    risk = f"{risk}+whitespace_normalization_skipped"
                    explanation = f"{explanation}, whitespace_normalization_skipped"
                else:
                    proposed_annotations = normalized_annotations
                    proposed = normalized_target
                    risk = f"{risk}+whitespace_normalized"
                    explanation = f"{explanation}, whitespace_normalized"
        recovery_evidence["whitespace_normalization"] = whitespace_audit
        if recovery_evidence.get("possible_deleted_rows"):
            if "approval_state_uncertain" not in risk:
                risk = f"{risk}+approval_state_uncertain"
            if "approval_state_uncertain" not in explanation:
                explanation = f"{explanation}, approval_state_uncertain"
            confidence = "low"
        candidate_body = {
            "text_id": record["text_id"],
            "task_id": record["task_id"],
            "author_id": record["author_id"],
            "source": source,
            "restored_target": restored,
            "recovery_evidence_hash": recovery_evidence["evidence_hash"],
            "proposed_target": proposed,
            "proposed_annotations": proposed_annotations,
        }
        candidate_hash = content_hash(candidate_body)
        status = (
            "approved"
            if preserve_approval
            or (
                previous
                and previous.get("candidate_hash") == candidate_hash
                and previous.get("status") == "approved"
            )
            else "pending"
        )
        items.append(
            {
                **candidate_body,
                "current_target": current,
                "restored_target": restored,
                "recovery_evidence": recovery_evidence,
                "original_fingerprint": record["fingerprint"],
                "candidate_hash": candidate_hash,
                "confidence": confidence,
                "risk": risk,
                "explanation": explanation,
                "status": status,
                "note": None,
                "uncertainty_acknowledged": bool(
                    preserve_approval and previous.get("uncertainty_acknowledged")
                ),
            }
        )
    revision = int((previous_manifest or {}).get("revision") or 0) + 1
    body: dict[str, object] = {
        "format": "annotation-repair-bundle-v2"
        if snapshot_format.endswith("v2")
        else "annotation-repair-bundle-v1",
        "category_id": snapshot["category_id"],
        "source_snapshot_hash": snapshot["snapshot_hash"],
        "revision": revision,
        "items": items,
    }
    body["batch_id"] = content_hash(body)
    return body


def build_repair_audit_report(bundle: dict[str, object]) -> dict[str, object]:
    if bundle.get("format") not in {"annotation-repair-bundle-v1", "annotation-repair-bundle-v2"}:
        raise AnnotationRepairError("Unsupported repair bundle format")
    if bundle.get("batch_id") != content_hash(
        {key: value for key, value in bundle.items() if key != "batch_id"}
    ):
        raise AnnotationRepairError("Repair bundle hash does not match its content")

    items = list(bundle.get("items") or [])

    def ids_where(predicate) -> list[int]:
        return sorted(int(item["text_id"]) for item in items if predicate(item))

    categories = {
        "approval_state_uncertain": ids_where(
            lambda item: bool((item.get("recovery_evidence") or {}).get("possible_deleted_rows"))
        ),
        "frontend_backend_mismatch": ids_where(
            lambda item: bool((item.get("recovery_evidence") or {}).get("projection_mismatch"))
        ),
        "restored_differs_from_current": ids_where(
            lambda item: item.get("restored_target") != item.get("current_target")
        ),
        "diff_reconstructed": ids_where(
            lambda item: "diff_reconstructed" in str(item.get("risk") or "")
        ),
        "label_review_required": ids_where(
            lambda item: any(
                (annotation.get("payload") or {}).get("label_needs_review") is True
                for annotation in item.get("proposed_annotations") or []
            )
        ),
        "manual_edit": ids_where(lambda item: "manual_edit" in str(item.get("risk") or "")),
        "reviewer_target": ids_where(lambda item: "reviewer_target" in str(item.get("risk") or "")),
        "whitespace_normalized": ids_where(
            lambda item: (item.get("recovery_evidence") or {})
            .get("whitespace_normalization", {})
            .get("status")
            == "applied"
        ),
        "whitespace_normalization_skipped": ids_where(
            lambda item: (item.get("recovery_evidence") or {})
            .get("whitespace_normalization", {})
            .get("status")
            == "skipped_unrepresentable"
        ),
        "low_confidence": ids_where(lambda item: item.get("confidence") == "low"),
    }
    whitespace_records = [
        {
            "text_id": int(item["text_id"]),
            **copy.deepcopy(
                (item.get("recovery_evidence") or {}).get("whitespace_normalization") or {}
            ),
        }
        for item in items
        if ((item.get("recovery_evidence") or {}).get("whitespace_normalization") or {}).get(
            "status"
        )
        == "applied"
    ]
    whitespace_skipped_records = [
        {
            "text_id": int(item["text_id"]),
            **copy.deepcopy(
                (item.get("recovery_evidence") or {}).get("whitespace_normalization") or {}
            ),
        }
        for item in items
        if ((item.get("recovery_evidence") or {}).get("whitespace_normalization") or {}).get(
            "status"
        )
        == "skipped_unrepresentable"
    ]
    body: dict[str, object] = {
        "format": "annotation-repair-audit-report-v1",
        "batch_id": bundle["batch_id"],
        "item_count": len(items),
        "categories": {
            name: {"count": len(text_ids), "text_ids": text_ids}
            for name, text_ids in categories.items()
        },
        "whitespace_normalization": {
            "affected_text_count": len(whitespace_records),
            "changed_boundary_count": sum(
                len(record.get("changes") or []) for record in whitespace_records
            ),
            "records": whitespace_records,
            "skipped_text_count": len(whitespace_skipped_records),
            "skipped_records": whitespace_skipped_records,
        },
    }
    body["report_hash"] = content_hash(body)
    return body


def import_repair_bundle(db: Session, bundle: dict[str, object]) -> AnnotationRepairBatch:
    if bundle.get("format") not in {"annotation-repair-bundle-v1", "annotation-repair-bundle-v2"}:
        raise AnnotationRepairError("Unsupported repair bundle format")
    batch_id = str(bundle.get("batch_id") or "")
    if batch_id != content_hash({key: value for key, value in bundle.items() if key != "batch_id"}):
        raise AnnotationRepairError("Repair bundle hash does not match its content")
    for item in bundle.get("items") or []:
        if bundle.get("format") == "annotation-repair-bundle-v2":
            evidence = item.get("recovery_evidence") or {}
            if evidence.get("evidence_hash") != _recovery_evidence_hash(evidence):
                raise AnnotationRepairError(
                    f"Recovery evidence hash does not match for text {item.get('text_id')}"
                )
            expected_candidate_hash = content_hash(
                {
                    "text_id": item.get("text_id"),
                    "task_id": item.get("task_id"),
                    "author_id": item.get("author_id"),
                    "source": item.get("source"),
                    "restored_target": item.get("restored_target"),
                    "recovery_evidence_hash": evidence.get("evidence_hash"),
                    "proposed_target": item.get("proposed_target"),
                    "proposed_annotations": item.get("proposed_annotations") or [],
                }
            )
            if item.get("candidate_hash") != expected_candidate_hash:
                raise AnnotationRepairError(
                    f"Repair proposal changed for text {item.get('text_id')}"
                )
        proposed = item.get("proposed_annotations") or []
        errors = _canonical_errors(proposed)
        if errors:
            raise AnnotationRepairError(
                f"Repair bundle contains invalid canonical annotations for text {item.get('text_id')}: "
                f"{'; '.join(errors)}"
            )
        if _render(str(item.get("source") or ""), proposed) != item.get("proposed_target"):
            raise AnnotationRepairError(
                f"Repair bundle target does not match annotations for text {item.get('text_id')}"
            )
    existing = db.get(AnnotationRepairBatch, batch_id)
    if existing:
        return existing
    if bundle.get("format") == "annotation-repair-bundle-v2":
        (
            db.query(AnnotationRepairBatch)
            .filter(
                AnnotationRepairBatch.category_id == int(bundle["category_id"]),
                AnnotationRepairBatch.status != "superseded",
            )
            .update({AnnotationRepairBatch.status: "superseded"}, synchronize_session=False)
        )
    batch = AnnotationRepairBatch(
        id=batch_id,
        category_id=int(bundle["category_id"]),
        revision=int(bundle.get("revision") or 1),
        source_snapshot_hash=str(bundle["source_snapshot_hash"]),
        item_count=len(bundle.get("items") or []),
    )
    db.add(batch)
    for item in bundle.get("items") or []:
        repair_item = AnnotationRepairItem(
            batch=batch,
            text_id=int(item["text_id"]),
            task_id=int(item["task_id"]),
            author_id=uuid.UUID(str(item["author_id"])),
            source_text=str(item["source"]),
            current_target=str(item["current_target"]),
            restored_target=str(item.get("restored_target") or item["current_target"]),
            proposed_target=str(item["proposed_target"]),
            original_fingerprint=str(item["original_fingerprint"]),
            candidate_hash=str(item["candidate_hash"]),
            confidence=str(item["confidence"]),
            risk=str(item["risk"]),
            explanation=str(item["explanation"]),
            proposed_annotations=copy.deepcopy(item["proposed_annotations"]),
            recovery_evidence=copy.deepcopy(item.get("recovery_evidence") or {}),
            uncertainty_acknowledged=bool(item.get("uncertainty_acknowledged", False)),
            status=str(item.get("status") or "pending"),
            note=item.get("note"),
        )
        repair_item.revisions.append(
            AnnotationRepairProposalRevision(
                revision=1,
                candidate_hash=repair_item.candidate_hash,
                proposed_target=repair_item.proposed_target,
                proposed_annotations=copy.deepcopy(repair_item.proposed_annotations),
                confidence=repair_item.confidence,
                risk=repair_item.risk,
                explanation=repair_item.explanation,
                reason="generated",
            )
        )
        db.add(repair_item)
    db.commit()
    return batch


def _candidate_hash_for_item(
    item: AnnotationRepairItem,
    proposed_target: str,
    proposed_annotations: list[dict[str, object]],
) -> str:
    return content_hash(
        {
            "text_id": item.text_id,
            "task_id": item.task_id,
            "author_id": str(item.author_id),
            "source": item.source_text,
            "restored_target": item.restored_target,
            "recovery_evidence_hash": item.recovery_evidence.get("evidence_hash"),
            "proposed_target": proposed_target,
            "proposed_annotations": proposed_annotations,
        }
    )


def _store_proposal_revision(
    item: AnnotationRepairItem,
    reviewer_id: uuid.UUID,
    reason: str,
) -> None:
    item.revisions.append(
        AnnotationRepairProposalRevision(
            revision=item.proposal_revision,
            candidate_hash=item.candidate_hash,
            proposed_target=item.proposed_target,
            proposed_annotations=copy.deepcopy(item.proposed_annotations),
            confidence=item.confidence,
            risk=item.risk,
            explanation=item.explanation,
            reason=reason,
            created_by_id=reviewer_id,
        )
    )


def revise_repair_proposal(
    db: Session,
    item: AnnotationRepairItem,
    reviewer_id: uuid.UUID,
    *,
    proposed_target: str | None = None,
    labels: dict[str, int] | None = None,
    restore_revision: int | None = None,
) -> AnnotationRepairItem:
    changes = sum(value is not None for value in (proposed_target, labels, restore_revision))
    if changes != 1:
        raise AnnotationRepairError("Specify exactly one proposal change")

    reason: str
    if restore_revision is not None:
        revision = (
            db.query(AnnotationRepairProposalRevision)
            .filter(
                AnnotationRepairProposalRevision.item_id == item.id,
                AnnotationRepairProposalRevision.revision == restore_revision,
            )
            .one_or_none()
        )
        if not revision:
            raise AnnotationRepairError("Repair proposal revision not found")
        target = revision.proposed_target
        annotations = copy.deepcopy(revision.proposed_annotations)
        item.confidence = revision.confidence
        item.risk = revision.risk
        item.explanation = revision.explanation
        reason = "restore"
    elif proposed_target is not None:
        target = proposed_target.replace("\r\n", "\n").replace("\r", "\n")
        if target == item.proposed_target:
            return item
        annotations = _reconstruct_canonical_diff(
            item.source_text,
            target,
            copy.deepcopy(item.proposed_annotations),
            item.text_id,
            require_changed_label_review=True,
        )
        reason = "target_edit"
        item.confidence = "low"
        risk_parts = [part for part in item.risk.split("+") if part]
        if "manual_edit" not in risk_parts:
            risk_parts.append("manual_edit")
        item.risk = "+".join(risk_parts)
        if "manual_edit" not in item.explanation:
            item.explanation = f"{item.explanation}, manual_edit".strip(", ")
    else:
        target = item.proposed_target
        annotations = copy.deepcopy(item.proposed_annotations)
        labels = labels or {}
        if not labels:
            raise AnnotationRepairError("At least one label assignment is required")
        known_correction_ids = {
            str((annotation.get("payload") or {}).get("client_correction_id"))
            for annotation in annotations
        }
        unknown = sorted(set(labels).difference(known_correction_ids))
        if unknown:
            raise AnnotationRepairError(f"Unknown correction IDs: {unknown[:5]}")
        known_error_types = {
            error_type_id
            for (error_type_id,) in db.query(ErrorType.id)
            .filter(ErrorType.id.in_(set(labels.values())))
            .all()
        }
        missing_error_types = sorted(set(labels.values()).difference(known_error_types))
        if missing_error_types:
            raise AnnotationRepairError(f"Unknown error type IDs: {missing_error_types}")
        for annotation in annotations:
            payload = annotation.get("payload") or {}
            correction_id = str(payload.get("client_correction_id"))
            if correction_id in labels:
                annotation["error_type_id"] = labels[correction_id]
                payload.pop("label_needs_review", None)
        reason = "label_edit"

    errors = _canonical_errors(annotations)
    if errors:
        raise AnnotationRepairError(f"Edited proposal is not canonical: {'; '.join(errors)}")
    if _render(item.source_text, annotations) != target:
        raise AnnotationRepairError(
            "Edited proposal operations do not reproduce the requested target"
        )

    item.proposed_target = target
    item.proposed_annotations = annotations
    item.candidate_hash = _candidate_hash_for_item(item, target, annotations)
    item.proposal_revision += 1
    item.status = "pending"
    item.uncertainty_acknowledged = False
    item.note = None
    item.reviewed_by_id = None
    item.reviewed_at = None
    _store_proposal_revision(item, reviewer_id, reason)
    db.commit()
    db.refresh(item)
    return item


def build_review_state(db: Session, batch_id: str) -> dict[str, object]:
    batch = db.get(AnnotationRepairBatch, batch_id)
    if not batch:
        raise AnnotationRepairError("Repair batch not found")
    items = (
        db.query(AnnotationRepairItem)
        .filter(AnnotationRepairItem.batch_id == batch_id)
        .order_by(AnnotationRepairItem.text_id, AnnotationRepairItem.task_id)
        .all()
    )
    body: dict[str, object] = {
        "format": "annotation-repair-review-state-v1",
        "batch_id": batch.id,
        "category_id": batch.category_id,
        "revision": batch.revision,
        "items": [
            {
                "text_id": item.text_id,
                "task_id": item.task_id,
                "candidate_hash": item.candidate_hash,
                "status": item.status,
                "note": item.note,
                "source_sha256": sha256_text(item.source_text),
                "original_fingerprint": item.original_fingerprint,
                "restored_target": item.restored_target,
                "proposed_target": item.proposed_target,
                "proposed_annotations": copy.deepcopy(item.proposed_annotations),
                "confidence": item.confidence,
                "risk": item.risk,
                "explanation": item.explanation,
                "uncertainty_acknowledged": item.uncertainty_acknowledged,
            }
            for item in items
        ],
    }
    body["review_state_hash"] = content_hash(body)
    return body


def build_approved_manifest(db: Session, batch_id: str) -> dict[str, object]:
    batch = db.get(AnnotationRepairBatch, batch_id)
    if not batch:
        raise AnnotationRepairError("Repair batch not found")
    if batch.status == "superseded":
        raise AnnotationRepairError("Superseded repair batches cannot produce a manifest")
    items = (
        db.query(AnnotationRepairItem)
        .filter(AnnotationRepairItem.batch_id == batch_id)
        .order_by(AnnotationRepairItem.text_id, AnnotationRepairItem.task_id)
        .all()
    )
    unresolved = [item.text_id for item in items if item.status != "approved"]
    if len(items) != batch.item_count or unresolved:
        raise AnnotationRepairError(
            f"All {batch.item_count} repair items must be approved; unresolved: {len(unresolved)}"
        )
    unlabeled = [
        item.text_id
        for item in items
        if any(
            annotation.get("error_type_id") is None
            or (annotation.get("payload") or {}).get("label_needs_review") is True
            for annotation in item.proposed_annotations
        )
    ]
    if unlabeled:
        raise AnnotationRepairError(
            f"Approved repair items contain unconfirmed correction labels: {unlabeled[:10]}"
        )
    unacknowledged = [
        item.text_id
        for item in items
        if item.recovery_evidence.get("possible_deleted_rows") and not item.uncertainty_acknowledged
    ]
    if unacknowledged:
        raise AnnotationRepairError(
            f"Uncertain approval-time recoveries require acknowledgement: {unacknowledged[:10]}"
        )
    body: dict[str, object] = {
        "format": "annotation-repair-manifest-v2",
        "batch_id": batch.id,
        "category_id": batch.category_id,
        "source_snapshot_hash": batch.source_snapshot_hash,
        "revision": batch.revision,
        "items": [
            {
                "text_id": item.text_id,
                "task_id": item.task_id,
                "author_id": str(item.author_id),
                "source_sha256": sha256_text(item.source_text),
                "original_fingerprint": item.original_fingerprint,
                "recovery_evidence_hash": item.recovery_evidence.get("evidence_hash"),
                "restored_target": item.restored_target,
                "restored_target_sha256": sha256_text(item.restored_target),
                "candidate_hash": item.candidate_hash,
                "approved_target": item.proposed_target,
                "proposed_annotations": copy.deepcopy(item.proposed_annotations),
                "status": "approved",
            }
            for item in items
        ],
    }
    body["manifest_hash"] = content_hash(body)
    return body


def verify_manifest(db: Session, manifest: dict[str, object]) -> list[dict[str, object]]:
    if manifest.get("format") not in {
        "annotation-repair-manifest-v1",
        "annotation-repair-manifest-v2",
    }:
        raise AnnotationRepairError("Unsupported repair manifest format")
    manifest_hash = manifest.get("manifest_hash")
    if manifest_hash != content_hash(
        {key: value for key, value in manifest.items() if key != "manifest_hash"}
    ):
        raise AnnotationRepairError("Repair manifest hash does not match its content")
    verified: list[dict[str, object]] = []
    for item in manifest.get("items") or []:
        if item.get("status") != "approved":
            raise AnnotationRepairError(f"Text {item.get('text_id')} is not approved")
        text = db.get(TextSample, int(item["text_id"]))
        task = db.get(AnnotationTask, int(item["task_id"]))
        if (
            not text
            or not task
            or task.text_id != text.id
            or str(task.annotator_id) != str(item["author_id"])
        ):
            raise AnnotationRepairError(f"Task identity changed for text {item['text_id']}")
        if manifest.get("format") == "annotation-repair-manifest-v2":
            restored_target = str(item.get("restored_target") or "")
            if sha256_text(restored_target) != item.get("restored_target_sha256"):
                raise AnnotationRepairError(
                    f"Approval-time evidence changed for text {item['text_id']}"
                )
            expected_candidate_hash = content_hash(
                {
                    "text_id": int(item["text_id"]),
                    "task_id": int(item["task_id"]),
                    "author_id": str(item["author_id"]),
                    "source": text.content or "",
                    "restored_target": restored_target,
                    "recovery_evidence_hash": item.get("recovery_evidence_hash"),
                    "proposed_target": item.get("approved_target"),
                    "proposed_annotations": item.get("proposed_annotations") or [],
                }
            )
            if expected_candidate_hash != item.get("candidate_hash"):
                raise AnnotationRepairError(f"Repair proposal changed for text {item['text_id']}")
        if sha256_text(text.content or "") != item["source_sha256"]:
            raise AnnotationRepairError(f"Source text changed for text {text.id}")
        annotations = (
            db.query(Annotation)
            .filter(Annotation.text_id == text.id, Annotation.author_id == task.annotator_id)
            .order_by(Annotation.id)
            .all()
        )
        rows = [annotation_snapshot(annotation) for annotation in annotations]
        if record_fingerprint(text.content or "", rows) != item["original_fingerprint"]:
            raise AnnotationRepairError(f"Annotation state changed for text {text.id}")
        proposed = [
            copy.deepcopy(annotation) for annotation in item.get("proposed_annotations") or []
        ]
        canonical_errors = _canonical_errors(proposed)
        if canonical_errors:
            raise AnnotationRepairError(
                f"Approved proposal is not canonical for text {text.id}: {'; '.join(canonical_errors)}"
            )
        if _render(text.content or "", proposed) != item["approved_target"]:
            raise AnnotationRepairError(
                f"Approved target does not match proposal for text {text.id}"
            )
        verified.append(
            {"item": item, "text": text, "task": task, "annotations": annotations, "before": rows}
        )
    return verified


def apply_manifest(db: Session, manifest: dict[str, object], *, dry_run: bool) -> dict[str, object]:
    verified = verify_manifest(db, manifest)
    try:
        before_m2_sha256 = sha256_text(
            build_m2_export([(row["text"], row["annotations"]) for row in verified]).content
        )
    except M2ExportError as exc:
        raise AnnotationRepairError(f"Pre-repair M2 verification failed: {exc}") from exc
    receipt: dict[str, object] = {
        "format": "annotation-repair-application-receipt-v1",
        "batch_id": manifest["batch_id"],
        "manifest_hash": manifest["manifest_hash"],
        "item_count": len(verified),
        "dry_run": dry_run,
        "targets_sha256": content_hash(
            [
                {"text_id": row["text"].id, "target": row["item"]["approved_target"]}
                for row in verified
            ]
        ),
        "before_m2_sha256": before_m2_sha256,
    }
    if dry_run:
        return receipt

    existing_application = (
        db.query(AnnotationRepairApplication)
        .filter(AnnotationRepairApplication.manifest_hash == manifest["manifest_hash"])
        .one_or_none()
    )
    if existing_application:
        raise AnnotationRepairError("This repair manifest was already applied")

    before_snapshot: dict[str, object] = {}
    after_snapshot: dict[str, object] = {}
    after_records: list[tuple[TextSample, list[Annotation]]] = []
    for row in verified:
        item = row["item"]
        text: TextSample = row["text"]
        task: AnnotationTask = row["task"]
        existing: list[Annotation] = row["annotations"]
        before_snapshot[str(text.id)] = row["before"]
        existing_by_id = {annotation.id: annotation for annotation in existing}
        retained: set[int] = set()
        applied: list[Annotation] = []
        for proposal in item.get("proposed_annotations") or []:
            annotation_id = proposal.get("id")
            annotation = existing_by_id.get(annotation_id) if annotation_id else None
            if annotation is None:
                annotation = Annotation(text_id=text.id, author_id=task.annotator_id)
                db.add(annotation)
            else:
                retained.add(annotation.id)
                annotation.version += 1
            annotation.start_token = int(proposal["start_token"])
            annotation.end_token = int(proposal["end_token"])
            annotation.replacement = proposal.get("replacement")
            annotation.error_type_id = proposal.get("error_type_id")
            annotation.error_type = (
                db.get(ErrorType, annotation.error_type_id) if annotation.error_type_id else None
            )
            annotation.payload = copy.deepcopy(proposal["payload"])
            db.flush()
            db.add(
                AnnotationVersion(
                    annotation_id=annotation.id,
                    version=annotation.version,
                    snapshot={
                        "start_token": annotation.start_token,
                        "end_token": annotation.end_token,
                        "replacement": annotation.replacement,
                        "payload": annotation.payload,
                        "error_type_id": annotation.error_type_id,
                    },
                )
            )
            applied.append(annotation)
        for annotation in existing:
            if annotation.id not in retained and annotation not in applied:
                db.delete(annotation)
        db.flush()
        rendered = render_corrected_text(text.content or "", applied)
        if rendered != item["approved_target"]:
            raise AnnotationRepairError(f"Applied target verification failed for text {text.id}")
        after_snapshot[str(text.id)] = [annotation_snapshot(annotation) for annotation in applied]
        after_records.append((text, applied))

    try:
        after_m2_sha256 = sha256_text(build_m2_export(after_records).content)
    except M2ExportError as exc:
        raise AnnotationRepairError(f"Post-repair M2 verification failed: {exc}") from exc
    receipt["after_m2_sha256"] = after_m2_sha256

    db.add(
        AnnotationRepairApplication(
            batch_id=str(manifest["batch_id"]),
            manifest_hash=str(manifest["manifest_hash"]),
            before_snapshot=before_snapshot,
            after_snapshot=after_snapshot,
            before_m2_sha256=before_m2_sha256,
            after_m2_sha256=after_m2_sha256,
        )
    )
    db.commit()
    return receipt


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text())


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))
