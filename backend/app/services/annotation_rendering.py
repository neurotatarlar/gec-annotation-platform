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
                    "origin": "inserted" if isinstance(frag, dict) and frag.get("origin") == "inserted" else None,
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
        if tok.get("kind") == "empty":
            continue
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


def _clone_token(token: dict) -> dict:
    cloned = dict(token)
    previous = token.get("previous_tokens")
    if isinstance(previous, list):
        cloned["previous_tokens"] = [_clone_token(item) for item in previous]
    return cloned


def _unwind_to_original(tokens: list[dict]) -> list[dict]:
    result: list[dict] = []
    for token in tokens:
        previous = token.get("previous_tokens")
        if isinstance(previous, list) and previous:
            result.extend(_unwind_to_original(previous))
        else:
            original = _clone_token(token)
            original.pop("previous_tokens", None)
            original.pop("move_id", None)
            result.append(original)
    return result


def _unwind_history_tokens(tokens: list[dict]) -> list[dict]:
    seen: set[tuple[str, str]] = set()
    result: list[dict] = []
    for token in _unwind_to_original([_clone_token(item) for item in tokens]):
        if token.get("kind") == "empty":
            continue
        key = (str(token.get("text") or ""), str(token.get("kind") or ""))
        if key in seen:
            continue
        seen.add(key)
        result.append(token)
    return result


def _before_token_ids(payload: dict) -> list[str]:
    value = payload.get("before_tokens")
    return [str(item) for item in value] if isinstance(value, list) else []


def _after_token_fragments(payload: dict) -> list[dict]:
    value = payload.get("after_tokens")
    return [item if isinstance(item, dict) else {"text": str(item)} for item in value] if isinstance(value, list) else []


def _move_from(ann: object, payload: dict) -> int:
    for key in ("move_from", "moveFrom"):
        value = payload.get(key)
        if isinstance(value, int):
            return value
    value = getattr(ann, "start_token", None)
    return value if isinstance(value, int) else 0


def _move_to(ann: object, payload: dict) -> int:
    for key in ("move_to", "moveTo"):
        value = payload.get(key)
        if isinstance(value, int):
            return value
    value = getattr(ann, "start_token", None)
    return value if isinstance(value, int) else 0


def _move_length(ann: object, payload: dict, before_ids: list[str], after: list[dict]) -> int:
    value = payload.get("move_len")
    if isinstance(value, int):
        return value
    return len(after) or len(before_ids) or 1


def _annotation_sort_key(ann: object) -> tuple:
    operation = normalize_operation(ann)
    ann_id = getattr(ann, "id", None) or 0
    if operation == "move":
        payload = coerce_payload(getattr(ann, "payload", None))
        move_from = _move_from(ann, payload)
        move_to = _move_to(ann, payload)
        direction = -1 if move_from < move_to else 1 if move_from > move_to else 0
        directional_from = -move_from if direction == -1 else move_from
        return (0, move_to, direction, directional_from, ann_id)
    start = getattr(ann, "start_token", None)
    end = getattr(ann, "end_token", None)
    return (1, start if isinstance(start, int) else 0, end if isinstance(end, int) else 0, ann_id)


def _find_range_for_original_ids(tokens: list[dict], before_ids: list[str]) -> tuple[int, int] | None:
    if not before_ids:
        return None
    ids = set(before_ids)
    indices: list[int] = []
    for index, token in enumerate(tokens):
        if token.get("kind") == "empty":
            continue
        if token.get("id") in ids:
            indices.append(index)
            continue
        previous = token.get("previous_tokens")
        if isinstance(previous, list) and any(item.get("id") in ids for item in _unwind_to_original(previous)):
            indices.append(index)
    return (min(indices), max(indices)) if indices else None


def _original_span(
    token: dict,
    original_index_by_id: dict[str, int],
    move_target_by_id: dict[str, tuple[int, int]],
    *,
    skip_move_destination: bool = False,
    skip_inserted: bool = False,
) -> tuple[int, int] | None:
    if skip_inserted and token.get("origin") == "inserted":
        return None
    move_id = token.get("move_id")
    if move_id and skip_move_destination and token.get("kind") != "empty":
        return None
    if move_id and token.get("kind") != "empty" and move_id in move_target_by_id:
        return move_target_by_id[move_id]
    indices: list[int] = []
    direct = original_index_by_id.get(str(token.get("id")))
    if direct is not None:
        indices.append(direct)
    previous = token.get("previous_tokens")
    if isinstance(previous, list) and previous:
        for item in _unwind_to_original(previous):
            index = original_index_by_id.get(str(item.get("id")))
            if index is not None:
                indices.append(index)
    return (min(indices), max(indices)) if indices else None


def _find_insertion_index(
    tokens: list[dict],
    original_index_by_id: dict[str, int],
    target_index: int,
    move_target_by_id: dict[str, tuple[int, int]],
    *,
    skip_move_destination: bool = False,
    skip_inserted: bool = False,
) -> int:
    for index, token in enumerate(tokens):
        span = _original_span(
            token,
            original_index_by_id,
            move_target_by_id,
            skip_move_destination=skip_move_destination,
            skip_inserted=skip_inserted,
        )
        if span and span[0] >= target_index:
            return index
    return len(tokens)


def _find_empty_move_insertion_index(
    tokens: list[dict],
    original_index_by_id: dict[str, int],
    target_index: int,
    move_target_by_id: dict[str, tuple[int, int]],
) -> int:
    index = _find_insertion_index(
        tokens,
        original_index_by_id,
        target_index,
        move_target_by_id,
        skip_move_destination=True,
    )
    while index > 0:
        span = _original_span(
            tokens[index - 1],
            original_index_by_id,
            move_target_by_id,
            skip_move_destination=True,
        )
        if span:
            break
        index -= 1
    return index


def _find_preferred_range(
    tokens: list[dict],
    before_ids: list[str],
    original_index_by_id: dict[str, int],
    move_target_by_id: dict[str, tuple[int, int]],
    target_index: int,
) -> tuple[int, int] | None:
    ids = set(before_ids)
    candidates: list[tuple[int, tuple[int, int]]] = []
    for index, token in enumerate(tokens):
        previous = token.get("previous_tokens")
        if token.get("kind") == "empty" and not previous:
            continue
        direct = token.get("id") in ids
        history_match = isinstance(previous, list) and any(
            item.get("id") in ids for item in _unwind_to_original(previous)
        )
        if not direct and not history_match:
            continue
        span = _original_span(token, original_index_by_id, move_target_by_id)
        if span:
            candidates.append((index, span))
    if not candidates:
        return None

    anchor = max(0, target_index)

    def distance(span: tuple[int, int]) -> int:
        if anchor < span[0]:
            return span[0] - anchor
        if anchor > span[1]:
            return anchor - span[1]
        return 0

    best_index, best_span = candidates[0]
    best_distance = distance(best_span)
    for index, span in candidates[1:]:
        candidate_distance = distance(span)
        if candidate_distance < best_distance or (candidate_distance == best_distance and index > best_index):
            best_index, best_span, best_distance = index, span, candidate_distance
    overlapping = [index for index, span in candidates if span[0] <= best_span[1] and best_span[0] <= span[1]]
    return min(overlapping), max(overlapping)


def _find_matching_slice(tokens: list[dict], pattern: list[dict], preferred_index: int) -> int | None:
    if not pattern or preferred_index < 0 or preferred_index + len(pattern) > len(tokens):
        return None
    for token, expected in zip(tokens[preferred_index : preferred_index + len(pattern)], pattern):
        if token.get("kind") == "empty" or token.get("move_id"):
            return None
        if token.get("text") != expected.get("text") or token.get("kind") != expected.get("kind"):
            return None
        if expected.get("origin") == "inserted" and token.get("origin") != "inserted":
            return None
    return preferred_index


def apply_annotations(tokens: list[dict], annotations: list[object]) -> list[dict]:
    next_id = 0

    def create_id(prefix: str = "token") -> str:
        nonlocal next_id
        value = f"{prefix}-{next_id}"
        next_id += 1
        return value

    base_tokens: list[dict] = []
    for index, token in enumerate(tokens):
        base = _clone_token(token)
        base.setdefault("id", f"base-{index}")
        base_tokens.append(base)
    working = [_clone_token(token) for token in base_tokens]
    original_by_id = {str(token["id"]): token for token in base_tokens if token.get("kind") != "empty"}
    original_index_by_id = {
        str(token["id"]): index for index, token in enumerate(base_tokens) if token.get("kind") != "empty"
    }
    offset_deltas: list[tuple[int, int]] = []
    move_target_by_id: dict[str, tuple[int, int]] = {}

    def offset_at(index: int) -> int:
        return sum(delta for start, delta in offset_deltas if start <= index)

    def clamp_index(idx: int) -> int:
        return max(0, min(len(working), idx))

    sorted_anns = sorted(annotations, key=_annotation_sort_key)
    for ann in sorted_anns:
        payload = coerce_payload(getattr(ann, "payload", None))
        operation = normalize_operation(ann)
        if operation == "noop":
            continue
        annotation_label = resolve_label(ann)
        before_ids = _before_token_ids(payload)
        after_fragments = _after_token_fragments(payload)
        if operation == "move":
            move_from = _move_from(ann, payload)
            move_to = _move_to(ann, payload)
            has_original_ids = bool(before_ids)
            move_len = _move_length(ann, payload, before_ids, after_fragments)
            matched_range = _find_range_for_original_ids(working, before_ids)
            source_start = clamp_index(move_from + offset_at(move_from))
            source_end = max(source_start, min(len(working) - 1, source_start + move_len - 1))
            if matched_range:
                source_start, source_end = matched_range
                move_len = source_end - source_start + 1
            move_id = create_id("move")
            raw_payload_tokens = build_tokens_from_fragments(
                after_fragments,
                getattr(ann, "replacement", None) or "",
                None,
            )
            use_source_slice = has_original_ids or matched_range is not None
            if not use_source_slice and raw_payload_tokens:
                matching_index = _find_matching_slice(working, raw_payload_tokens, source_start)
                if matching_index is not None:
                    source_start = matching_index
                    source_end = matching_index + len(raw_payload_tokens) - 1
                    move_len = source_end - source_start + 1
                    use_source_slice = True
            mapped_history = [
                {key: value for key, value in _clone_token(original_by_id[item]).items() if key != "previous_tokens"}
                for item in before_ids
                if item in original_by_id
            ]
            history = (
                mapped_history
                if mapped_history
                else _unwind_history_tokens(working[source_start : source_end + 1])
                if use_source_slice
                else []
            )
            placeholder = {
                "id": create_id(),
                "text": "⬚",
                "kind": "empty",
                "space_before": working[source_start].get("space_before", True) if source_start < len(working) else True,
                "previous_tokens": [_clone_token(token) for token in history],
                "move_id": move_id,
            }
            raw_moved = raw_payload_tokens or (
                [_clone_token(token) for token in working[source_start : source_end + 1]] if use_source_slice else []
            )
            if use_source_slice:
                del working[source_start : source_end + 1]
            working.insert(source_start, placeholder)
            insertion_index = (
                _find_insertion_index(
                    working,
                    original_index_by_id,
                    move_to,
                    move_target_by_id,
                    skip_move_destination=True,
                )
                if has_original_ids
                else _find_empty_move_insertion_index(working, original_index_by_id, move_to, move_target_by_id)
            )
            insertion_index = clamp_index(insertion_index)
            leading_space = get_leading_space(working, insertion_index)
            moved: list[dict] = []
            for index, token in enumerate(raw_moved):
                moved_token = _clone_token(token)
                moved_token["id"] = create_id()
                moved_token["move_id"] = move_id
                moved_token["annotation_labels"] = sorted(
                    {str(label) for label in moved_token.get("annotation_labels", [])} | {annotation_label}
                )
                if index == 0:
                    moved_token["space_before"] = leading_space
                previous = moved_token.get("previous_tokens")
                if not previous and history:
                    moved_token["previous_tokens"] = [_clone_token(item) for item in history]
                moved.append(moved_token)
            working[insertion_index:insertion_index] = moved
            move_target_by_id[move_id] = (move_to, move_to + max(1, len(moved)) - 1)
            if has_original_ids:
                offset_deltas.append((move_from, 1 - move_len))
            offset_deltas.append((move_to, len(moved)))
            continue

        start_value = getattr(ann, "start_token", None)
        start_original = start_value if isinstance(start_value, int) else 0
        end_value = getattr(ann, "end_token", None)
        end_original = end_value if isinstance(end_value, int) else start_original
        target_start = clamp_index(start_original + offset_at(start_original))
        if operation == "insert":
            if not before_ids:
                target_start = _find_insertion_index(
                    working,
                    original_index_by_id,
                    start_original,
                    move_target_by_id,
                    skip_inserted=True,
                )
            else:
                anchor = _find_preferred_range(
                    working,
                    before_ids,
                    original_index_by_id,
                    move_target_by_id,
                    start_original - 1,
                )
                if anchor:
                    target_start = min(len(working), anchor[1] + 1)
                elif move_target_by_id:
                    candidate_ids = {
                        move_id for move_id, span in move_target_by_id.items() if span[1] == start_original - 1
                    }
                    anchor_index = None
                    for index, token in enumerate(working):
                        if token.get("kind") != "empty" and token.get("move_id") in candidate_ids:
                            anchor_index = index
                    if anchor_index is not None:
                        target_start = min(len(working), anchor_index + 1)
        leading_space = get_leading_space(working, target_start)
        span_count = 0 if operation == "insert" else max(
            0, min(len(working) - target_start, max(0, end_original - start_original + 1))
        )
        before_count = (
            min(len(working) - target_start, len(before_ids)) if operation != "insert" and before_ids else 0
        )
        remove_count = before_count if before_count > 0 else span_count
        mapped_history = [
            {key: value for key, value in _clone_token(original_by_id[item]).items() if key != "previous_tokens"}
            for item in before_ids
            if item in original_by_id
        ]
        previous_raw = [_clone_token(token) for token in working[target_start : target_start + remove_count]]
        fallback_history: list[dict] = []
        if not previous_raw and not mapped_history and before_ids:
            count = min(len(before_ids), len(base_tokens))
            if count:
                start_index = min(max(0, start_original), max(0, len(base_tokens) - count))
                fallback_history = [_clone_token(token) for token in base_tokens[start_index : start_index + count]]
        previous = previous_raw or mapped_history or fallback_history
        if operation == "insert" and not previous:
            previous = [{"id": create_id(), "text": "⬚", "kind": "empty", "previous_tokens": []}]
        replacement_text = getattr(ann, "replacement", None) or ""
        new_tokens = build_tokens_from_fragments(
            after_fragments,
            replacement_text,
            leading_space,
        )
        if not new_tokens and operation in {"delete", "insert"}:
            new_tokens = [
                {
                    "id": create_id(),
                    "text": "⬚",
                    "kind": "empty",
                    "space_before": leading_space,
                    "previous_tokens": [_clone_token(token) for token in previous],
                }
            ]
        else:
            for token in new_tokens:
                token["id"] = create_id()
                token["previous_tokens"] = [_clone_token(item) for item in previous]
                inherited_labels = {
                    str(label)
                    for previous_token in previous
                    for label in previous_token.get("annotation_labels", [])
                }
                token["annotation_labels"] = sorted(inherited_labels | {annotation_label})
            if new_tokens and not (
                after_fragments
                and isinstance(after_fragments[0], dict)
                and isinstance(after_fragments[0].get("space_before", after_fragments[0].get("spaceBefore")), bool)
            ):
                new_tokens[0]["space_before"] = leading_space
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
