"""
Pure helpers for rendering corrected text and export edit records from annotations.
"""

import re
from typing import Iterable

from pydantic import BaseModel


def resolve_label(ann: object) -> str:
    error_type = getattr(ann, "error_type", None)
    if error_type:
        return (
            getattr(error_type, "en_name", None)
            or getattr(error_type, "tt_name", None)
            or getattr(error_type, "category_en", None)
            or getattr(error_type, "category_tt", None)
            or "OTHER"
        )
    return "OTHER"


def render_replacement(ann: object) -> str:
    replacement = getattr(ann, "replacement", None)
    if replacement:
        return replacement
    payload = getattr(ann, "payload", None) or {}
    after_tokens = payload.get("after_tokens") if isinstance(payload, dict) else None
    if isinstance(after_tokens, list):
        texts: list[str] = []
        for token in after_tokens:
            if isinstance(token, dict):
                texts.append(str(token.get("text") or ""))
            else:
                text_val = getattr(token, "text", "") or ""
                texts.append(str(text_val))
        candidate = " ".join(texts).strip()
        if candidate:
            return candidate
    return "-NONE-"


_SPECIAL_TOKEN_SOURCES = [
    r"\+\d[\d()\- ]*\d",
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    r"(https?:\/\/[^\s,;:!]+|www\.[^\s,;:!]+)",
]
_SPECIAL_TOKEN_FULL = [re.compile(rf"^{src}$") for src in _SPECIAL_TOKEN_SOURCES]
_SPECIAL_TOKEN_MATCHERS = [re.compile(src) for src in _SPECIAL_TOKEN_SOURCES]
_BASE_REGEX = re.compile(r"(\w+)|[^\w\s]", re.UNICODE)


def is_punct_only(value: str) -> bool:
    return bool(value) and all(not ch.isalnum() for ch in value)


def is_special_token(value: str) -> bool:
    trimmed = re.sub(r"[.,;:!?]+$", "", value or "")
    if not trimmed:
        return False
    return any(regex.match(trimmed) for regex in _SPECIAL_TOKEN_FULL)


def tokenize_to_tokens(text: str) -> list[dict]:
    tokens: list[dict] = []
    if not text:
        return tokens
    idx = 0
    while idx < len(text):
        had_space = False
        while idx < len(text) and text[idx].isspace():
            had_space = True
            idx += 1
        if idx >= len(text):
            break
        matched = False
        for matcher in _SPECIAL_TOKEN_MATCHERS:
            res = matcher.match(text, idx)
            if not res:
                continue
            raw = res.group(0)
            value = re.sub(r"[.,;:!?]+$", "", raw)
            advance_by = len(value) or len(raw)
            if value:
                tokens.append(
                    {
                        "text": value,
                        "kind": "special",
                        "space_before": False if not tokens else had_space,
                    }
                )
            idx += advance_by
            matched = True
            break
        if matched:
            continue
        base_match = _BASE_REGEX.match(text, idx)
        if base_match:
            value = base_match.group(0)
            tokens.append(
                {
                    "text": value,
                    "kind": "punct" if is_punct_only(value) else "word",
                    "space_before": False if not tokens else had_space,
                }
            )
            idx += len(value)
            continue
        idx += 1
    return tokens


def compute_line_breaks(text: str) -> list[int]:
    breaks: list[int] = []
    if not text:
        return breaks
    lines = text.split("\n")
    count = 0
    for idx, line in enumerate(lines):
        line_tokens = tokenize_to_tokens(line)
        count += len(line_tokens)
        if idx < len(lines) - 1:
            breaks.append(count)
    return breaks


def build_tokens_from_snapshot(snapshot: list[str], source_text: str) -> list[dict]:
    tokens: list[dict] = []
    cursor = 0
    for idx, text in enumerate(snapshot):
        has_space = False
        while cursor < len(source_text) and source_text[cursor].isspace():
            has_space = True
            cursor += 1
        next_index = source_text.find(text, cursor) if text else -1
        if next_index > cursor:
            chunk = source_text[cursor:next_index]
            if any(ch.isspace() for ch in chunk):
                has_space = True
            cursor = next_index
        kind = "special" if is_special_token(text) else "punct" if is_punct_only(text) else "word"
        tokens.append(
            {
                "text": text,
                "kind": kind,
                "space_before": False if idx == 0 else has_space,
            }
        )
        if next_index >= 0:
            cursor = next_index + len(text)
    return tokens


def resolve_tokens_snapshot_for_source(source: str, annotations: Iterable[object]) -> list[dict]:
    snapshot: list[str] | None = None
    for ann in annotations:
        payload = coerce_payload(getattr(ann, "payload", None))
        maybe_tokens = payload.get("text_tokens")
        if isinstance(maybe_tokens, list) and maybe_tokens:
            snapshot = [str(token) for token in maybe_tokens if token is not None]
            break
    if snapshot:
        return build_tokens_from_snapshot(snapshot, source)
    return tokenize_to_tokens(source)


def resolve_tokens_snapshot(text: object, annotations: list[object]) -> list[dict]:
    return resolve_tokens_snapshot_for_source(getattr(text, "content", None) or "", annotations)


def tokenize_edited_text(text: str) -> list[dict]:
    tokens: list[dict] = []
    if not text:
        return tokens
    parts = re.split(r"(\s+)", text)
    space_before = False
    for part in parts:
        if not part:
            continue
        if part.isspace():
            space_before = True
            continue
        tokens.append(
            {
                "text": part,
                "kind": "punct" if is_punct_only(part) else "word",
                "space_before": space_before,
            }
        )
        space_before = False
    return tokens


def build_tokens_from_fragments(
    fragments: list[dict],
    fallback_text: str,
    default_first_space: bool | None,
) -> list[dict]:
    built: list[dict] = []
    base_fragments = fragments if fragments else ([{"text": fallback_text}] if fallback_text else [])
    for frag_index, frag in enumerate(base_fragments):
        text = frag.get("text") if isinstance(frag, dict) else str(frag)
        if not text:
            continue
        explicit_space = None
        if isinstance(frag, dict):
            if isinstance(frag.get("space_before"), bool):
                explicit_space = frag.get("space_before")
            if isinstance(frag.get("spaceBefore"), bool):
                explicit_space = frag.get("spaceBefore")
        base_tokens = tokenize_edited_text(text)
        for idx, tok in enumerate(base_tokens):
            space_before = tok["space_before"]
            if idx == 0:
                if explicit_space is not None:
                    space_before = explicit_space
                elif frag_index > 0:
                    space_before = False if tok["kind"] == "punct" else True
                elif default_first_space is not None:
                    space_before = default_first_space
            if idx == 0 and frag_index > 0 and space_before is False and tok["kind"] != "punct":
                space_before = True
            built.append(
                {
                    "text": tok["text"],
                    "kind": tok["kind"],
                    "space_before": space_before,
                }
            )
    return built


def get_leading_space(tokens: list[dict], index: int) -> bool:
    if index <= 0:
        return False
    if index >= len(tokens):
        return True
    return tokens[index].get("space_before") is not False


def build_text_from_tokens_with_breaks(tokens: list[dict], breaks: list[int]) -> str:
    break_counts: dict[int, int] = {}
    for idx in breaks:
        break_counts[idx] = break_counts.get(idx, 0) + 1
    visible_idx = 0
    at_line_start = True
    result_parts: list[str] = []
    for tok in tokens:
        text = tok.get("text") or ""
        if not text:
            continue
        needs_space = not at_line_start and tok.get("space_before") is not False
        if needs_space:
            result_parts.append(" ")
        result_parts.append(text)
        visible_idx += 1
        count = break_counts.get(visible_idx, 0)
        if count:
            result_parts.append("\n" * count)
            at_line_start = True
        else:
            at_line_start = False
    return "".join(result_parts)


def coerce_payload(payload: object | None) -> dict:
    if payload is None:
        return {}
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, BaseModel):
        return payload.model_dump()
    if hasattr(payload, "model_dump"):
        return payload.model_dump()
    if hasattr(payload, "dict"):
        return payload.dict()
    return dict(payload)


def normalize_operation(ann: object) -> str:
    payload = coerce_payload(getattr(ann, "payload", None))
    op = payload.get("operation") or ("replace" if getattr(ann, "replacement", None) else "noop")
    before_tokens = payload.get("before_tokens") or []
    after_tokens = payload.get("after_tokens") or []
    has_replacement = bool(getattr(ann, "replacement", None))
    if op == "noop" and (before_tokens or after_tokens or has_replacement):
        return "replace"
    return str(op)


def apply_annotations(tokens: list[dict], annotations: list[object]) -> list[dict]:
    working = [dict(tok) for tok in tokens]
    offset_deltas: list[tuple[int, int]] = []

    def offset_at(index: int) -> int:
        return sum(delta for start, delta in offset_deltas if start <= index)

    def clamp_index(idx: int) -> int:
        return max(0, min(len(working), idx))

    sorted_anns = sorted(
        annotations,
        key=lambda ann: (
            0 if normalize_operation(ann) == "move" else 1,
            getattr(ann, "start_token", None) or 0,
            getattr(ann, "end_token", None) or 0,
            getattr(ann, "id", None) or 0,
        ),
    )
    for ann in sorted_anns:
        payload = coerce_payload(getattr(ann, "payload", None))
        operation = normalize_operation(ann)
        if operation == "noop":
            continue
        if operation == "move":
            move_from = payload.get("move_from")
            if not isinstance(move_from, int):
                move_from = payload.get("moveFrom")
            if not isinstance(move_from, int):
                move_from = getattr(ann, "start_token", None) or 0
            move_to = payload.get("move_to")
            if not isinstance(move_to, int):
                move_to = payload.get("moveTo")
            if not isinstance(move_to, int):
                move_to = getattr(ann, "start_token", None) or 0
            move_len = payload.get("move_len")
            after_tokens = payload.get("after_tokens") or []
            before_tokens = payload.get("before_tokens") or []
            if not isinstance(move_len, int):
                move_len = len(after_tokens) or len(before_tokens) or max(
                    1,
                    (getattr(ann, "end_token", None) or 0) - (getattr(ann, "start_token", None) or 0) + 1,
                )
            source_start = clamp_index(move_from + offset_at(move_from))
            source_end = max(source_start, min(len(working) - 1, source_start + move_len - 1))
            moved = working[source_start : source_end + 1]
            del working[source_start : source_end + 1]
            insertion_index = clamp_index(move_to + offset_at(move_to))
            if insertion_index > source_start:
                insertion_index -= len(moved)
            insertion_index = clamp_index(insertion_index)
            leading_space = get_leading_space(working, insertion_index)
            if moved:
                moved[0]["space_before"] = leading_space
            working[insertion_index:insertion_index] = moved
            continue

        start_original = getattr(ann, "start_token", None) or 0
        end_original = getattr(ann, "end_token", None) or start_original
        target_start = clamp_index(start_original + offset_at(start_original))
        leading_space = get_leading_space(working, target_start)
        before_tokens = payload.get("before_tokens") or []
        remove_count = 0
        if operation != "insert":
            if isinstance(before_tokens, list) and before_tokens:
                remove_count = len(before_tokens)
            else:
                remove_count = max(0, end_original - start_original + 1)
        if target_start + remove_count > len(working):
            remove_count = max(0, len(working) - target_start)
        after_tokens = payload.get("after_tokens") or []
        replacement_text = getattr(ann, "replacement", None) or ""
        new_tokens = build_tokens_from_fragments(
            after_tokens if isinstance(after_tokens, list) else [],
            replacement_text,
            leading_space,
        )
        if operation == "delete":
            new_tokens = []
        working[target_start : target_start + remove_count] = new_tokens
        offset_deltas.append((start_original, len(new_tokens) - remove_count))
    return working


def render_corrected_text(source: str, annotations: Iterable[object]) -> str:
    annotation_list = list(annotations)
    base_tokens = resolve_tokens_snapshot_for_source(source, annotation_list)
    line_breaks = compute_line_breaks(source)
    corrected_tokens = apply_annotations(base_tokens, annotation_list)
    return build_text_from_tokens_with_breaks(corrected_tokens, line_breaks)


def annotation_to_edit(ann: object) -> dict:
    payload = getattr(ann, "payload", None) or {}
    operation = normalize_operation(ann)
    move_from = payload.get("move_from")
    if move_from is None:
        move_from = payload.get("moveFrom")
    move_to = payload.get("move_to")
    if move_to is None:
        move_to = payload.get("moveTo")
    move_len = payload.get("move_len")
    if move_len is None:
        move_len = payload.get("moveLen")
    return {
        "start_token": getattr(ann, "start_token", None),
        "end_token": getattr(ann, "end_token", None),
        "operation": operation,
        "error_type": resolve_label(ann),
        "replacement": None if getattr(ann, "replacement", None) is None else str(getattr(ann, "replacement", None)),
        "move_from": move_from if isinstance(move_from, int) else None,
        "move_to": move_to if isinstance(move_to, int) else None,
        "move_len": move_len if isinstance(move_len, int) else None,
    }


def build_export_record(
    text: object,
    annotations: list[object],
) -> dict:
    source = getattr(text, "content", None) or ""
    target = render_corrected_text(source, annotations)
    edits = [
        annotation_to_edit(ann)
        for ann in sorted(
            annotations,
            key=lambda ann: (
                getattr(ann, "start_token", None),
                getattr(ann, "end_token", None),
                getattr(ann, "id", None) or 0,
            ),
        )
    ]
    return {
        "id": getattr(text, "id", None),
        "source": source,
        "target": target,
        "edits": edits,
    }
