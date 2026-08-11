"""Validated conversion of persisted annotation state to canonical M2 blocks."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from .annotation_rendering import (
    apply_annotations,
    coerce_payload,
    normalize_operation,
    resolve_label,
    resolve_tokens_snapshot_for_source,
)
from .annotation_saves import sha256_text, sha256_tokens


M2_DELIMITER = "|||"
M2_NONE = "-NONE-"


class M2ExportError(ValueError):
    """Raised when one text cannot be exported without losing annotation meaning."""

    def __init__(self, text_id: int | None, detail: str):
        self.text_id = text_id
        self.detail = detail
        prefix = f"Text {text_id}: " if text_id is not None else ""
        super().__init__(f"{prefix}{detail}")


@dataclass(frozen=True)
class AlignedEdit:
    source_start: int
    source_end: int
    target_start: int
    target_end: int


@dataclass(frozen=True)
class M2Edit:
    start: int
    end: int
    error_type: str
    correction: tuple[str, ...]
    label_status: str
    candidate_labels: tuple[str, ...]


@dataclass(frozen=True)
class M2LabelIssue:
    text_id: int | None
    start: int
    end: int
    status: str
    candidate_labels: tuple[str, ...]


@dataclass(frozen=True)
class M2BlockResult:
    text_id: int | None
    block: str
    source_tokens: tuple[str, ...]
    target_tokens: tuple[str, ...]
    edit_count: int
    other_count: int
    ambiguous_label_count: int
    unattributed_label_count: int
    label_issues: tuple[M2LabelIssue, ...]
    noop: bool


@dataclass(frozen=True)
class M2ExportAudit:
    selected_texts: int
    annotation_rows: int
    noop_texts: int
    m2_edits: int
    other_edits: int
    ambiguous_label_edits: int
    unattributed_label_edits: int
    multiline_texts: int


@dataclass(frozen=True)
class M2ExportResult:
    content: str
    audit: M2ExportAudit
    label_issues: tuple[M2LabelIssue, ...]


def _validate_field(value: str, field: str, text_id: int | None) -> str:
    if M2_DELIMITER in value:
        raise M2ExportError(text_id, f"{field} contains reserved M2 delimiter {M2_DELIMITER!r}")
    if "\n" in value or "\r" in value:
        raise M2ExportError(text_id, f"{field} contains an embedded line break")
    return value


def _semantic_render_tokens(tokens: Iterable[dict]) -> list[dict]:
    return [token for token in tokens if token.get("kind") != "empty" and token.get("text")]


def _semantic_tokens(tokens: Iterable[dict]) -> list[str]:
    return [str(token.get("text") or "") for token in _semantic_render_tokens(tokens)]


def _flatten_tokens(tokens: list[str], text_id: int | None) -> tuple[list[str], list[int]]:
    flattened: list[str] = []
    boundaries = [0]
    for token in tokens:
        parts = token.split()
        if not parts:
            raise M2ExportError(text_id, "semantic token becomes empty in M2 tokenization")
        for part in parts:
            flattened.append(_validate_field(part, "token", text_id))
        boundaries.append(len(flattened))
    return flattened, boundaries


def _flatten_target_tokens(
    tokens: list[dict], text_id: int | None
) -> tuple[list[str], list[set[str]]]:
    flattened: list[str] = []
    labels: list[set[str]] = []
    for token in tokens:
        parts = str(token.get("text") or "").split()
        if not parts:
            raise M2ExportError(text_id, "semantic target token becomes empty in M2 tokenization")
        token_labels = {str(label) for label in token.get("annotation_labels", [])}
        for part in parts:
            flattened.append(_validate_field(part, "token", text_id))
            labels.append(token_labels)
    return flattened, labels


def _validate_snapshot(text: object, annotations: list[object]) -> list[str]:
    text_id = getattr(text, "id", None)
    source = str(getattr(text, "content", None) or "")
    if not annotations:
        return _semantic_tokens(resolve_tokens_snapshot_for_source(source, []))

    snapshots: list[list[str]] = []
    for annotation in annotations:
        payload = coerce_payload(getattr(annotation, "payload", None))
        snapshot = payload.get("text_tokens")
        if not isinstance(snapshot, list) or not snapshot:
            raise M2ExportError(text_id, "annotation is missing its source token snapshot")
        normalized = [str(token) for token in snapshot]
        if payload.get("text_tokens_sha256") != sha256_tokens(normalized):
            raise M2ExportError(text_id, "annotation token snapshot hash does not match")
        if payload.get("text_sha256") != sha256_text(source):
            raise M2ExportError(text_id, "annotation source text hash does not match")
        snapshots.append(normalized)

    if any(snapshot != snapshots[0] for snapshot in snapshots[1:]):
        raise M2ExportError(text_id, "annotations use inconsistent source token snapshots")
    return snapshots[0]


def _align_atomic_tokens(source: list[str], target: list[str]) -> list[AlignedEdit]:
    """Return one deterministic alignment item for each non-equal DP step."""
    rows = len(source) + 1
    cols = len(target) + 1
    costs = [[0] * cols for _ in range(rows)]
    steps = [[""] * cols for _ in range(rows)]
    for i in range(1, rows):
        costs[i][0] = i
        steps[i][0] = "delete"
    for j in range(1, cols):
        costs[0][j] = j
        steps[0][j] = "insert"

    priority = {"replace": 0, "delete": 1, "insert": 2}
    for i in range(1, rows):
        for j in range(1, cols):
            if source[i - 1] == target[j - 1]:
                costs[i][j] = costs[i - 1][j - 1]
                steps[i][j] = "equal"
                continue
            candidates = [
                (costs[i - 1][j - 1] + 1, "replace"),
                (costs[i - 1][j] + 1, "delete"),
                (costs[i][j - 1] + 1, "insert"),
            ]
            costs[i][j], steps[i][j] = min(
                candidates, key=lambda candidate: (candidate[0], priority[candidate[1]])
            )

    atomic: list[str] = []
    i, j = len(source), len(target)
    while i or j:
        step = steps[i][j]
        atomic.append(step)
        if step in {"equal", "replace"}:
            i -= 1
            j -= 1
        elif step == "delete":
            i -= 1
        elif step == "insert":
            j -= 1
        else:
            raise AssertionError(f"Missing alignment step at {i}, {j}")
    atomic.reverse()

    edits: list[AlignedEdit] = []
    source_index = 0
    target_index = 0
    for step in atomic:
        if step == "equal":
            source_index += 1
            target_index += 1
            continue
        next_source = source_index + (1 if step in {"replace", "delete"} else 0)
        next_target = target_index + (1 if step in {"replace", "insert"} else 0)
        edits.append(AlignedEdit(source_index, next_source, target_index, next_target))
        source_index = next_source
        target_index = next_target
    return edits


def align_tokens(source: list[str], target: list[str]) -> list[AlignedEdit]:
    """Return deterministic minimum-cost, non-overlapping token edits."""
    grouped: list[AlignedEdit] = []
    for edit in _align_atomic_tokens(source, target):
        if (
            grouped
            and grouped[-1].source_end == edit.source_start
            and grouped[-1].target_end == edit.target_start
        ):
            previous = grouped[-1]
            grouped[-1] = AlignedEdit(
                previous.source_start,
                edit.source_end,
                previous.target_start,
                edit.target_end,
            )
        else:
            grouped.append(edit)
    return grouped


def _annotation_ranges(
    annotation: object, boundaries: list[int]
) -> tuple[list[tuple[int, int]], list[int]]:
    payload = coerce_payload(getattr(annotation, "payload", None))
    operation = normalize_operation(annotation)
    if operation == "noop":
        return [], []

    max_index = len(boundaries) - 1

    def boundary(index: int) -> int:
        return boundaries[max(0, min(max_index, index))]

    if operation == "move":
        move_from = payload.get("move_from", payload.get("moveFrom"))
        move_to = payload.get("move_to", payload.get("moveTo"))
        move_len = payload.get("move_len", payload.get("moveLen"))
        if not isinstance(move_from, int):
            move_from = int(getattr(annotation, "start_token", 0) or 0)
        if not isinstance(move_to, int):
            move_to = int(getattr(annotation, "start_token", 0) or 0)
        if not isinstance(move_len, int):
            move_len = max(
                1,
                int(getattr(annotation, "end_token", move_from) or move_from) - move_from + 1,
            )
        return [(boundary(move_from), boundary(move_from + move_len))], [boundary(move_to)]

    start = int(getattr(annotation, "start_token", 0) or 0)
    if operation == "insert":
        return [], [boundary(start)]
    end = int(
        getattr(annotation, "end_token", start)
        if getattr(annotation, "end_token", None) is not None
        else start
    )
    return [(boundary(start), boundary(end + 1))], []


def _edit_label_candidates(
    edit: AlignedEdit,
    annotations: list[object],
    boundaries: list[int],
    target_labels: list[set[str]],
) -> frozenset[str]:
    labels: list[str] = []
    for annotation in annotations:
        spans, _ = _annotation_ranges(annotation, boundaries)
        source_overlap = any(
            edit.source_start < end and start < edit.source_end for start, end in spans
        )
        if source_overlap:
            labels.append(resolve_label(annotation))
    for token_labels in target_labels[edit.target_start : edit.target_end]:
        labels.extend(token_labels)
    return frozenset(labels)


def _resolve_edit_label(labels: frozenset[str], text_id: int | None) -> tuple[str, str]:
    unique = sorted(labels)
    if not unique:
        return "OTHER", "unattributed"
    label = unique[0] if len(unique) == 1 else "OTHER"
    status = "exact" if len(unique) == 1 else "ambiguous"
    return _validate_field(label, "error type", text_id), status


def _group_edits_by_label_provenance(
    edits: list[AlignedEdit],
    annotations: list[object],
    boundaries: list[int],
    target_labels: list[set[str]],
) -> list[tuple[AlignedEdit, frozenset[str]]]:
    annotated = [
        (edit, _edit_label_candidates(edit, annotations, boundaries, target_labels))
        for edit in edits
    ]
    runs: list[list[tuple[AlignedEdit, frozenset[str]]]] = []
    for item in annotated:
        if (
            runs
            and runs[-1][-1][0].source_end == item[0].source_start
            and runs[-1][-1][0].target_end == item[0].target_start
        ):
            runs[-1].append(item)
        else:
            runs.append([item])

    attributed: list[tuple[AlignedEdit, frozenset[str]]] = []
    for run in runs:
        for index, (edit, labels) in enumerate(run):
            if labels:
                attributed.append((edit, labels))
                continue
            left = next((item[1] for item in reversed(run[:index]) if item[1]), frozenset())
            right = next((item[1] for item in run[index + 1 :] if item[1]), frozenset())
            attributed.append((edit, left | right))

    grouped: list[tuple[AlignedEdit, frozenset[str]]] = []
    for edit, labels in attributed:
        if (
            grouped
            and grouped[-1][1] == labels
            and grouped[-1][0].source_end == edit.source_start
            and grouped[-1][0].target_end == edit.target_start
        ):
            previous = grouped[-1][0]
            grouped[-1] = (
                AlignedEdit(
                    previous.source_start,
                    edit.source_end,
                    previous.target_start,
                    edit.target_end,
                ),
                labels,
            )
        else:
            grouped.append((edit, labels))
    return grouped


def _serialize_edit(edit: M2Edit, text_id: int | None) -> str:
    correction = " ".join(edit.correction) if edit.correction else M2_NONE
    correction = _validate_field(correction, "correction", text_id)
    return (
        f"A {edit.start} {edit.end}{M2_DELIMITER}{edit.error_type}{M2_DELIMITER}"
        f"{correction}{M2_DELIMITER}REQUIRED{M2_DELIMITER}{M2_NONE}{M2_DELIMITER}0"
    )


def parse_and_apply_m2_block(block: str) -> tuple[list[str], list[str]]:
    """Independently parse one generated M2 block and apply its edits."""
    lines = [line for line in block.splitlines() if line]
    if not lines or not lines[0].startswith("S "):
        raise ValueError("M2 block must start with an S line")
    source = lines[0][2:].split()
    edits: list[tuple[int, int, list[str]]] = []
    for line in lines[1:]:
        parts = line.split(M2_DELIMITER)
        if len(parts) != 6 or not parts[0].startswith("A "):
            raise ValueError("Malformed M2 annotation line")
        span = parts[0][2:].split()
        if len(span) != 2:
            raise ValueError("Malformed M2 span")
        start, end = map(int, span)
        if start == -1 and end == -1:
            continue
        if not (0 <= start <= end <= len(source)):
            raise ValueError("M2 span is outside the source token range")
        correction = [] if parts[2] == M2_NONE else parts[2].split()
        edits.append((start, end, correction))
    ordered = sorted(edits, key=lambda item: (item[0], item[1]))
    if any(left[1] > right[0] for left, right in zip(ordered, ordered[1:])):
        raise ValueError("M2 edits overlap")
    target = list(source)
    for start, end, correction in reversed(ordered):
        target[start:end] = correction
    return source, target


def build_m2_block(text: object, annotations: list[object]) -> M2BlockResult:
    text_id = getattr(text, "id", None)
    source_text = str(getattr(text, "content", None) or "")
    if M2_DELIMITER in source_text:
        raise M2ExportError(text_id, f"source contains reserved M2 delimiter {M2_DELIMITER!r}")
    source_snapshot = _validate_snapshot(text, annotations)
    source_render_tokens = resolve_tokens_snapshot_for_source(source_text, annotations)
    if _semantic_tokens(source_render_tokens) != source_snapshot:
        raise M2ExportError(text_id, "renderer did not hydrate the validated source snapshot")
    target_render_tokens = apply_annotations(source_render_tokens, annotations)
    target_semantic_tokens = _semantic_render_tokens(target_render_tokens)
    source_tokens, boundaries = _flatten_tokens(source_snapshot, text_id)
    target_tokens, target_labels = _flatten_target_tokens(target_semantic_tokens, text_id)

    aligned = _group_edits_by_label_provenance(
        _align_atomic_tokens(source_tokens, target_tokens),
        annotations,
        boundaries,
        target_labels,
    )
    m2_edits: list[M2Edit] = []
    for edit, labels in aligned:
        error_type, label_status = _resolve_edit_label(labels, text_id)
        m2_edits.append(
            M2Edit(
                start=edit.source_start,
                end=edit.source_end,
                error_type=error_type,
                correction=tuple(target_tokens[edit.target_start : edit.target_end]),
                label_status=label_status,
                candidate_labels=tuple(sorted(labels)),
            )
        )
    lines = [f"S {' '.join(source_tokens)}"]
    if m2_edits:
        lines.extend(_serialize_edit(edit, text_id) for edit in m2_edits)
    else:
        lines.append(
            f"A -1 -1{M2_DELIMITER}noop{M2_DELIMITER}{M2_NONE}{M2_DELIMITER}REQUIRED{M2_DELIMITER}{M2_NONE}{M2_DELIMITER}0"
        )
    block = "\n".join(lines)
    parsed_source, parsed_target = parse_and_apply_m2_block(block)
    if parsed_source != source_tokens or parsed_target != target_tokens:
        raise M2ExportError(text_id, "independent M2 round-trip did not reconstruct target")
    return M2BlockResult(
        text_id=text_id,
        block=block,
        source_tokens=tuple(source_tokens),
        target_tokens=tuple(target_tokens),
        edit_count=len(m2_edits),
        other_count=sum(edit.error_type == "OTHER" for edit in m2_edits),
        ambiguous_label_count=sum(edit.label_status == "ambiguous" for edit in m2_edits),
        unattributed_label_count=sum(edit.label_status == "unattributed" for edit in m2_edits),
        label_issues=tuple(
            M2LabelIssue(
                text_id=text_id,
                start=edit.start,
                end=edit.end,
                status=edit.label_status,
                candidate_labels=edit.candidate_labels,
            )
            for edit in m2_edits
            if edit.label_status != "exact"
        ),
        noop=not m2_edits,
    )


def build_m2_export(records: list[tuple[object, list[object]]]) -> M2ExportResult:
    blocks = [build_m2_block(text, annotations) for text, annotations in records]
    audit = M2ExportAudit(
        selected_texts=len(blocks),
        annotation_rows=sum(len(annotations) for _, annotations in records),
        noop_texts=sum(block.noop for block in blocks),
        m2_edits=sum(block.edit_count for block in blocks),
        other_edits=sum(block.other_count for block in blocks),
        ambiguous_label_edits=sum(block.ambiguous_label_count for block in blocks),
        unattributed_label_edits=sum(block.unattributed_label_count for block in blocks),
        multiline_texts=sum(
            "\n" in str(getattr(text, "content", None) or "") for text, _ in records
        ),
    )
    content = "\n\n".join(block.block for block in blocks)
    if content:
        content += "\n"
    return M2ExportResult(
        content=content,
        audit=audit,
        label_issues=tuple(issue for block in blocks for issue in block.label_issues),
    )
