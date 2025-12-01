import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { AnnotationDetailPayload, AnnotationDraft, ErrorType, TokenFragmentPayload } from "../types";
import {
  colorWithAlpha,
  getErrorTypeLabel,
  getErrorTypeSuperLabel,
} from "../utils/errorTypes";

// ---------------------------
// Types and data structures
// ---------------------------
// TokenKind includes <EMPTY> technical placeholder.
export type TokenKind = "word" | "punct" | "empty" | "special";

// Token represents a single chip in the editor.
export type Token = {
  id: string;
  text: string;
  kind: TokenKind;
  selected: boolean;
  previousTokens?: Token[];
  groupId?: string;
  origin?: "inserted";
  moveId?: string;
};

// MoveMarker helps visualize a drag move (old position -> new position).
type MoveMarker = {
  id: string;
  fromStart: number;
  fromEnd: number;
  toStart: number;
  toEnd: number;
};

// Present (undoable) state: originalTokens are read-only, tokens are editable.
export type EditorPresentState = {
  originalTokens: Token[];
  tokens: Token[];
  moveMarkers: MoveMarker[];
};

// History state for undo/redo.
export type EditorHistoryState = {
  past: EditorPresentState[];
  present: EditorPresentState;
  future: EditorPresentState[];
};

// Reducer actions. Most UI-specific data (like selection range) is provided in payload.
type Action =
  | { type: "INIT_FROM_TEXT"; text: string }
  | { type: "INIT_FROM_STATE"; state: EditorPresentState }
  | { type: "DELETE_SELECTED_TOKENS"; range: [number, number] }
  | { type: "INSERT_TOKEN_BEFORE_SELECTED"; range: [number, number] | null }
  | { type: "INSERT_TOKEN_AFTER_SELECTED"; range: [number, number] | null }
  | { type: "EDIT_SELECTED_RANGE_AS_TEXT"; range: [number, number]; newText: string }
  | { type: "MERGE_RANGE"; range: [number, number] }
  | { type: "MERGE_WITH_NEXT"; index: number }
  | { type: "MOVE_SELECTED_BY_DRAG"; fromIndex: number; toIndex: number; count: number }
  | { type: "CANCEL_INSERT_PLACEHOLDER"; range: [number, number] }
  | { type: "CLEAR_ALL" }
  | { type: "REVERT_CORRECTION"; rangeStart: number; rangeEnd: number; markerId: string | null }
  | { type: "UNDO" }
  | { type: "REDO" };

// ---------------------------
// Utilities
// ---------------------------
// Treat any non-letter/number/non-space as punctuation/symbol.
const punctuation = /[^\p{L}\p{N}\s]/u;
let idCounter = 0;
const createId = () => `token-${idCounter++}`;

type HotkeySpec = {
  key: string;
  code?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
};

const normalizeHotkeySpec = (spec: HotkeySpec, useCode = false) => {
  const parts = [];
  if (spec.ctrl) parts.push("ctrl");
  if (spec.alt) parts.push("alt");
  if (spec.shift) parts.push("shift");
  if (spec.meta) parts.push("meta");
  parts.push(useCode && spec.code ? `code:${spec.code}` : spec.key);
  return parts.join("+");
};

export const guessCodeFromKey = (key: string): string | null => {
  if (!key || key.length !== 1) return null;
  if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/[0-9]/.test(key)) return `Digit${key}`;
  return null;
};

export const parseHotkey = (raw: string | null | undefined): HotkeySpec | null => {
  if (!raw) return null;
  const parts = raw
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let key: string | null = null;
  parts.forEach((part) => {
    if (part === "ctrl" || part === "control") ctrl = true;
    else if (part === "alt" || part === "option") alt = true;
    else if (part === "shift") shift = true;
    else if (part === "meta" || part === "cmd" || part === "command") meta = true;
    else if (part.length === 1) {
      if (key) {
        // Multiple non-modifier keys are not supported; treat as invalid.
        key = null;
      } else {
        key = part;
      }
    }
  });
  if (!key) return null;
  return { key, code: guessCodeFromKey(key), ctrl, alt, shift, meta };
};

// Tokenizer: splits into words vs punctuation, skipping spaces.
export const tokenizeToTokens = (text: string): Token[] => {
  const tokens: Token[] = [];
  if (!text) return tokens;

  const specialMatchers: Array<{ regex: RegExp }> = [
    // Phone numbers starting with +
    { regex: /\+\d[\d()\- ]*\d/y },
    // Emails
    { regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/y },
    // URLs (http/https/www)
    { regex: /(https?:\/\/[^\s,;:!]+|www\.[^\s,;:!]+)/y },
  ];
  const baseRegex = /(\p{L}|\p{N})+|[^\p{L}\p{N}\s]/uy;

  let idx = 0;
  while (idx < text.length) {
    // Skip whitespace
    if (/\s/.test(text[idx])) {
      idx += 1;
      continue;
    }

    let matched = false;
    for (const m of specialMatchers) {
      m.regex.lastIndex = idx;
      const res = m.regex.exec(text);
      if (res && res.index === idx) {
        const raw = res[0];
        const value = raw.replace(/[.,;:!?]+$/, "");
        const advanceBy = value.length || raw.length;
        tokens.push({
          id: createId(),
          text: value,
          kind: "special",
          selected: false,
          origin: undefined,
        });
        idx += advanceBy;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    baseRegex.lastIndex = idx;
      const baseMatch = baseRegex.exec(text);
      if (baseMatch && baseMatch.index === idx) {
        const value = baseMatch[0];
        const isWord = !punctuation.test(value);
        tokens.push({
        id: createId(),
        text: value,
        kind: isWord ? "word" : "punct",
        selected: false,
        origin: undefined,
      });
      idx += value.length;
      continue;
    }

    // If nothing matched, advance to avoid infinite loop.
    idx += 1;
  }

  return tokens;
};

export const buildHotkeyMap = (errorTypes: ErrorType[]) => {
  const map: Record<string, number> = {};
  errorTypes
    .filter((et) => et.is_active)
    .forEach((et) => {
      const spec = parseHotkey(et.default_hotkey);
      if (!spec) return;
      const norm = normalizeHotkeySpec(spec);
      map[norm] = et.id;
      const code = spec.code;
      if (code) {
        const codeNorm = normalizeHotkeySpec({ ...spec, code }, true);
        map[codeNorm] = et.id;
      }
    });
  return map;
};

const cloneTokens = (items: Token[]) =>
  items.map((t) => ({
    ...t,
    previousTokens: t.previousTokens?.map((p) => ({ ...p })),
    origin: t.origin,
    moveId: t.moveId,
  }));

const makeEmptyPlaceholder = (previousTokens: Token[]): Token => ({
  id: createId(),
  text: "⬚",
  kind: "empty",
  selected: false,
  previousTokens,
  origin: undefined,
});

// Unwind correction chains to the earliest known state (walk previousTokens until none).
const unwindToOriginal = (tokens: Token[]): Token[] => {
  const result: Token[] = [];
  tokens.forEach((tok) => {
    if (tok.previousTokens && tok.previousTokens.length) {
      result.push(...unwindToOriginal(tok.previousTokens));
    } else {
      result.push({ ...tok, previousTokens: undefined, selected: false });
    }
  });
  return result;
};

// Remove ⬚ tokens that carry no history (pure placeholders).
const dropRedundantEmpties = (tokens: Token[]): Token[] =>
  tokens.filter((tok) => !(tok.kind === "empty" && (!tok.previousTokens || tok.previousTokens.length === 0)));

// Remove duplicate earliest tokens (by text+kind) to prevent double restore.
const dedupeTokens = (tokens: Token[]): Token[] => {
  const seen = new Set<string>();
  const result: Token[] = [];
  tokens.forEach((tok) => {
    const key = `${tok.text}|${tok.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(tok);
  });
  return result;
};

const rangeToArray = (range: [number, number]) => {
  const [start, end] = range;
  const arr: number[] = [];
  for (let i = start; i <= end; i += 1) arr.push(i);
  return arr;
};

// Detect the placeholder token we create for insertions (text empty + previous empty marker).
const isInsertPlaceholder = (tokens: Token[]) =>
  tokens.length === 1 &&
  tokens[0].text === "" &&
  tokens[0].previousTokens?.length &&
  tokens[0].previousTokens.every((p) => p.kind === "empty");

// Build a merged token from a slice, omitting ⬚ tokens from text and history.
const buildMergedToken = (slice: Token[]): Token | null => {
  const nonEmpty = slice.filter((tok) => tok.kind !== "empty");
  if (!nonEmpty.length) return null;
  const mergedText = nonEmpty.map((tok) => tok.text).join("").trim(); // collapse whitespace for a single merged token
  const history: Token[] = [];
  slice.forEach((tok) => {
    if (tok.kind !== "empty") {
      history.push({ ...tok, selected: false });
    }
    if (tok.previousTokens) {
      const nested = cloneTokens(tok.previousTokens).filter((p) => p.kind !== "empty");
      history.push(...nested);
    }
  });
  return {
    id: createId(),
    text: mergedText,
    kind: nonEmpty[0].kind,
    selected: false,
    previousTokens: history,
    groupId: createId(),
  };
};

// Compare sequences by visible content (text + kind) ignoring ids and previousTokens.
const sameTokenSequence = (existing: Token[], nextRaw: Token[]) => {
  if (existing.length !== nextRaw.length) return false;
  for (let i = 0; i < existing.length; i += 1) {
    if (existing[i].text !== nextRaw[i].text || existing[i].kind !== nextRaw[i].kind) {
      return false;
    }
  }
  return true;
};

// Push a new present into history (standard undo/redo pattern).
const pushPresent = (state: EditorHistoryState, nextPresent: EditorPresentState): EditorHistoryState => ({
  past: [...state.past, state.present],
  present: nextPresent,
  future: [],
});

export const createInitialHistoryState = (): EditorHistoryState => ({
  past: [],
  present: { originalTokens: [], tokens: [], moveMarkers: [] },
  future: [],
});

// Build earliest-known originals for a block: if any token in the block has history, use the union of all histories;
// otherwise fall back to unwinding the block itself.
const buildOriginalHistoryForBlock = (block: Token[]): Token[] => {
  const hasHistory = block.some((t) => t.previousTokens && t.previousTokens.length);
  const source: Token[] = [];
  if (hasHistory) {
    block.forEach((tok) => {
      if (tok.previousTokens && tok.previousTokens.length) {
        source.push(...cloneTokens(tok.previousTokens));
      }
    });
  } else {
    source.push(...cloneTokens(block));
  }
  return dedupeTokens(unwindToOriginal(source))
    .filter((t) => t.kind !== "empty")
    .map((t) => ({ ...t, previousTokens: undefined, selected: false, groupId: undefined, moveId: undefined }));
};

// Derive move markers from tokens (so moves stay atomic even after other edits).
const deriveMoveMarkers = (tokens: Token[]): MoveMarker[] => {
  const map = new Map<
    string,
    {
      from?: number;
      toStart?: number;
      toEnd?: number;
    }
  >();
  tokens.forEach((tok, idx) => {
    if (!tok.moveId) return;
    const entry = map.get(tok.moveId) ?? {};
    if (tok.kind === "empty" && tok.previousTokens && tok.previousTokens.length) {
      entry.from = idx;
    } else {
      entry.toStart = entry.toStart === undefined ? idx : Math.min(entry.toStart, idx);
      entry.toEnd = entry.toEnd === undefined ? idx : Math.max(entry.toEnd, idx);
    }
    map.set(tok.moveId, entry);
  });
  return Array.from(map.entries())
    .map(([id, v]) => {
      if (v.from === undefined) return null;
      const toStart = v.toStart ?? v.from;
      const toEnd = v.toEnd ?? v.from;
      return {
        id,
        fromStart: v.from,
        fromEnd: v.from,
        toStart,
        toEnd,
      };
    })
    .filter(Boolean) as MoveMarker[];
};

// ---------------------------
// Reducer
// ---------------------------
const reducer = (state: EditorHistoryState, action: Action): EditorHistoryState => {
  switch (action.type) {
    case "INIT_FROM_TEXT": {
      const original = tokenizeToTokens(action.text);
      const present: EditorPresentState = {
        originalTokens: cloneTokens(original),
        tokens: cloneTokens(original),
        moveMarkers: deriveMoveMarkers(original),
      };
      return { past: [], present, future: [] };
    }
    case "INIT_FROM_STATE": {
      const present: EditorPresentState = {
        originalTokens: cloneTokens(action.state.originalTokens),
        tokens: cloneTokens(action.state.tokens),
        moveMarkers: [...action.state.moveMarkers],
      };
      return { past: [], present, future: [] };
    }
    case "DELETE_SELECTED_TOKENS": {
      let [start, end] = action.range;
      if (start < 0 || end < start || start >= state.present.tokens.length) return state;
      const tokens = cloneTokens(state.present.tokens);
      const markersNow = deriveMoveMarkers(tokens);
      // If selection intersects a move marker (either placeholder or destination), revert the whole move atomically.
      const hitMarker = markersNow.find(
        (m) =>
          (start <= m.fromEnd && end >= m.fromStart) ||
          (start <= m.toEnd && end >= m.toStart)
      );
      if (hitMarker) {
        const placeholderIndex = hitMarker.fromStart;
        const placeholder = tokens[placeholderIndex];
        tokens.splice(placeholderIndex, 1);
        const blockStart = placeholderIndex < hitMarker.toStart ? hitMarker.toStart - 1 : hitMarker.toStart;
        const blockLen = hitMarker.toEnd - hitMarker.toStart + 1;
        tokens.splice(blockStart, blockLen);
        const restore =
          placeholder?.previousTokens?.length
            ? buildOriginalHistoryForBlock(placeholder.previousTokens)
            : [makeEmptyPlaceholder([])];
        tokens.splice(placeholderIndex, 0, ...restore);
        const next: EditorPresentState = {
          ...state.present,
          tokens: dropRedundantEmpties(tokens),
          moveMarkers: state.present.moveMarkers.filter((m) => m.id !== hitMarker.id),
        };
        return pushPresent(state, next);
      }
      // Expand selection to include the whole inserted group if selection intersects it.
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (let i = start; i <= end; i += 1) {
          const tok = tokens[i];
          if (tok?.origin === "inserted") {
            const gid = tok.groupId ?? null;
            let l = i;
            let r = i;
            while (
              l - 1 >= 0 &&
              tokens[l - 1].origin === "inserted" &&
              (tokens[l - 1].groupId ?? null) === gid
            ) {
              l -= 1;
            }
            while (
              r + 1 < tokens.length &&
              tokens[r + 1].origin === "inserted" &&
              (tokens[r + 1].groupId ?? null) === gid
            ) {
              r += 1;
            }
            if (l < start || r > end) {
              start = Math.min(start, l);
              end = Math.max(end, r);
              expanded = true;
              break;
            }
          }
        }
      }
      // Expand selection to include entire correction group (e.g., split result) sharing the same groupId that carries history.
      expanded = true;
      while (expanded) {
        expanded = false;
        for (let i = start; i <= end; i += 1) {
          const tok = tokens[i];
          if (tok?.groupId) {
            const gid = tok.groupId;
            let l = i;
            let r = i;
            while (
              l - 1 >= 0 &&
              tokens[l - 1].groupId === gid
            ) {
              l -= 1;
            }
            while (
              r + 1 < tokens.length &&
              tokens[r + 1].groupId === gid
            ) {
              r += 1;
            }
            if (l < start || r > end) {
              start = Math.min(start, l);
              end = Math.max(end, r);
              expanded = true;
              break;
            }
          }
        }
      }
      const removed = tokens.slice(start, end + 1);
      // If user deletes only inserted tokens, treat it as reverting that insertion (no placeholder).
      const allInserted = removed.every((t) => t.origin === "inserted");
      if (allInserted) {
        tokens.splice(start, removed.length);
        const next: EditorPresentState = { ...state.present, tokens, moveMarkers: deriveMoveMarkers(tokens) };
        return pushPresent(state, next);
      }
      // If selection contains a correction cluster (e.g., split) with history, restore the original tokens instead of adding ⬚.
      const anchorWithHistory = removed.find((t) => t.previousTokens && t.previousTokens.length);
      if (anchorWithHistory) {
        const restore = dedupeTokens(unwindToOriginal(cloneTokens(anchorWithHistory.previousTokens!))).map((tok) => ({
          ...tok,
          previousTokens: undefined,
          selected: false,
          origin: tok.origin,
        }));
        tokens.splice(start, removed.length, ...restore);
        const cleanedTokens = dropRedundantEmpties(tokens);
        const next: EditorPresentState = { ...state.present, tokens: cleanedTokens, moveMarkers: deriveMoveMarkers(cleanedTokens) };
        return pushPresent(state, next);
      }
      // If a single empty with no history, just remove it.
      if (removed.length === 1 && removed[0].kind === "empty" && !removed[0].previousTokens?.length) {
        tokens.splice(start, removed.length);
        const next: EditorPresentState = { ...state.present, tokens, moveMarkers: deriveMoveMarkers(tokens) };
        return pushPresent(state, next);
      }
      const previousTokens = dedupeTokens(removed.flatMap((t) => unwindToOriginal([t])).map((tok) => ({ ...tok, selected: false })));
      if (!previousTokens.length) {
        previousTokens.push(makeEmptyPlaceholder([]));
      }
      const placeholder = makeEmptyPlaceholder(previousTokens);
      tokens.splice(start, removed.length, placeholder);
      const next: EditorPresentState = { ...state.present, tokens, moveMarkers: deriveMoveMarkers(tokens) };
      return pushPresent(state, next);
    }
    case "INSERT_TOKEN_BEFORE_SELECTED": {
      if (!action.range) return state;
      const [start] = action.range;
      const tokens = cloneTokens(state.present.tokens);
      const inserted: Token = {
        id: createId(),
        text: "",
        kind: "word",
        selected: false,
        // Show a placeholder history so the annotator sees the implicit ⬚.
        previousTokens: [makeEmptyPlaceholder([])],
        origin: "inserted",
      };
      tokens.splice(start, 0, inserted);
      const next: EditorPresentState = { ...state.present, tokens, moveMarkers: deriveMoveMarkers(tokens) };
      // Do NOT push to history yet; this is a transient insertion until user confirms.
      return { ...state, present: next, future: [] };
    }
    case "INSERT_TOKEN_AFTER_SELECTED": {
      if (!action.range) return state;
      const tokens = cloneTokens(state.present.tokens);
      const [, end] = action.range;
      const inserted: Token = {
        id: createId(),
        text: "",
        kind: "word",
        selected: false,
        previousTokens: [makeEmptyPlaceholder([])],
        origin: "inserted",
      };
      tokens.splice(end + 1, 0, inserted);
      const next: EditorPresentState = { ...state.present, tokens, moveMarkers: deriveMoveMarkers(tokens) };
      // Do NOT push to history yet; this is a transient insertion until user confirms.
      return { ...state, present: next, future: [] };
    }
    case "EDIT_SELECTED_RANGE_AS_TEXT": {
      let [start, end] = action.range;
      const tokens = cloneTokens(state.present.tokens);
      // Always expand the edit to the full correction group so re-edits stay in-place.
      const gid = tokens[start]?.groupId;
      if (gid) {
        while (start - 1 >= 0 && tokens[start - 1]?.groupId === gid) start -= 1;
        while (end + 1 < tokens.length && tokens[end + 1]?.groupId === gid) end += 1;
      }
      const oldSlice = tokens.slice(start, end + 1);
      const oldSliceAllInserted = oldSlice.every((tok) => tok.origin === "inserted");
      const flattenedOld: Token[] = [];
      oldSlice.forEach((tok) => {
        flattenedOld.push({ ...tok, selected: false });
        if (tok.previousTokens) {
          flattenedOld.push(...cloneTokens(tok.previousTokens));
        }
      });
      const newTokensRaw = tokenizeToTokens(action.newText);
      // If this was a newly inserted placeholder and user left it empty, revert to previous present.
      const newlyInsertedEmpty = newTokensRaw.length === 0 && isInsertPlaceholder(oldSlice);
      if (newlyInsertedEmpty && state.past.length) {
        const prior = state.past[state.past.length - 1];
        return { past: state.past.slice(0, -1), present: prior, future: state.future };
      }
      // If user didn't change the content (text/kind sequence is identical), do nothing.
      if (newTokensRaw.length && sameTokenSequence(oldSlice, newTokensRaw)) {
        return state;
      }
      const moveIdReuse =
        oldSlice.length > 0 && oldSlice.every((tok) => tok.moveId === oldSlice[0].moveId)
          ? oldSlice[0].moveId
          : undefined;
      const existingGroupId =
        oldSlice.length > 0 && oldSlice.every((tok) => tok.groupId === oldSlice[0].groupId) ? oldSlice[0].groupId : null;
      const anchorExistingHistory =
        oldSlice.find((tok) => tok.previousTokens && tok.previousTokens.length) ??
        (existingGroupId ? tokens.find((t) => t.groupId === existingGroupId && t.previousTokens && t.previousTokens.length) : undefined);
      const reuseHistory = Boolean(existingGroupId && anchorExistingHistory?.previousTokens?.length);
      const baseHistoryRaw = reuseHistory ? cloneTokens(anchorExistingHistory!.previousTokens!) : flattenedOld;
      const baseHistory = dedupeTokens(unwindToOriginal(baseHistoryRaw));

      const groupId = reuseHistory && existingGroupId ? existingGroupId : createId();
      let replacement: Token[] = newTokensRaw.length
        ? cloneTokens(newTokensRaw).map((tok) => ({ ...tok, groupId, moveId: moveIdReuse }))
        : [{ ...makeEmptyPlaceholder([]), moveId: moveIdReuse }];
      if (oldSliceAllInserted) {
        replacement = replacement.map((tok) => ({ ...tok, origin: "inserted" }));
      }
      if (newTokensRaw.length) {
        const anchorIndex = Math.floor((replacement.length - 1) / 2);
        replacement = replacement.map((tok, idx) =>
          idx === anchorIndex ? { ...tok, previousTokens: baseHistory } : tok
        );
      } else {
        replacement[0].previousTokens = baseHistory;
      }
      tokens.splice(start, oldSlice.length, ...replacement);
      const next: EditorPresentState = { ...state.present, tokens, moveMarkers: deriveMoveMarkers(tokens) };
      if (oldSliceAllInserted) {
        // Do not record the transient empty insertion; push the pre-insert snapshot instead.
        const preInsertTokens = cloneTokens(state.present.tokens);
        preInsertTokens.splice(start, oldSlice.length); // remove the placeholder slice
        const pastEntry: EditorPresentState = {
          ...state.present,
          tokens: preInsertTokens,
          moveMarkers: deriveMoveMarkers(preInsertTokens),
        };
        return {
          past: [...state.past, pastEntry],
          present: next,
          future: [],
        };
      }
      return pushPresent(state, next);
    }
    case "MERGE_RANGE": {
      const [start, end] = action.range;
      if (start < 0 || end < start || end >= state.present.tokens.length) return state;
      const tokens = cloneTokens(state.present.tokens);
      const slice = tokens.slice(start, end + 1);
      if (slice.length <= 1) return state;
      const merged = buildMergedToken(slice);
      if (!merged) return state;
      // Preserve insertion origin if everything in the slice was originally inserted.
      if (slice.every((tok) => tok.origin === "inserted")) {
        merged.origin = "inserted";
      }
      tokens.splice(start, slice.length, merged);
      const nextState: EditorPresentState = { ...state.present, tokens, moveMarkers: deriveMoveMarkers(tokens) };
      return pushPresent(state, nextState);
    }
    case "CLEAR_ALL": {
      const original = state.present.originalTokens;
      const present: EditorPresentState = {
        originalTokens: cloneTokens(original),
        tokens: cloneTokens(original),
        moveMarkers: deriveMoveMarkers(original),
      };
      return pushPresent(state, present);
    }
    case "REVERT_CORRECTION": {
      const { rangeStart, rangeEnd, markerId } = action;
      const tokens = cloneTokens(state.present.tokens);
      // Revert move correction.
      if (markerId) {
        const markersNow = deriveMoveMarkers(tokens);
        const marker = markersNow.find((m) => m.id === markerId);
        if (!marker) return state;
        const placeholderIndex = marker.fromStart;
        const placeholder = tokens[placeholderIndex];
        // remove placeholder
        tokens.splice(placeholderIndex, 1);
        // compute block start after removing placeholder
        const blockStart = placeholderIndex < marker.toStart ? marker.toStart - 1 : marker.toStart;
        const blockLen = marker.toEnd - marker.toStart + 1;
        tokens.splice(blockStart, blockLen);
        const restore =
          placeholder?.previousTokens?.length
            ? buildOriginalHistoryForBlock(placeholder.previousTokens)
            : [makeEmptyPlaceholder([])];
        tokens.splice(placeholderIndex, 0, ...restore);
        const cleanedTokens = dropRedundantEmpties(tokens);
        const next: EditorPresentState = {
          ...state.present,
          tokens: cleanedTokens,
          moveMarkers: deriveMoveMarkers(cleanedTokens).filter((m) => m.id !== markerId),
        };
        return pushPresent(state, next);
      }

      // Revert standard correction by replacing range with previousTokens found in the anchor.
      const anchorIdx = tokens.findIndex(
        (tok, idx) =>
          idx >= rangeStart && idx <= rangeEnd && tok.previousTokens && tok.previousTokens.length
      );
      if (anchorIdx === -1) return state;
      const replacementRaw = tokens[anchorIdx].previousTokens?.length
        ? cloneTokens(tokens[anchorIdx].previousTokens!)
        : [makeEmptyPlaceholder([])];
      const replacement = dedupeTokens(unwindToOriginal(replacementRaw)).map((tok) => ({
        ...tok,
        previousTokens: undefined,
        selected: false,
      }));
      const rangeLen = rangeEnd - rangeStart + 1;
      // If the replacement is just a single empty placeholder with no history, drop the correction entirely.
      const isJustEmpty =
        replacement.length === 1 &&
        replacement[0].kind === "empty" &&
        (!replacement[0].previousTokens || replacement[0].previousTokens.length === 0);
      if (isJustEmpty) {
        tokens.splice(rangeStart, rangeLen);
      } else {
        tokens.splice(rangeStart, rangeLen, ...replacement);
      }
      const cleaned = dropRedundantEmpties(tokens);
      const next: EditorPresentState = { ...state.present, tokens: cleaned, moveMarkers: deriveMoveMarkers(cleaned) };
      return pushPresent(state, next);
    }
    case "MERGE_WITH_NEXT": {
      const tokens = cloneTokens(state.present.tokens);
      if (action.index < 0 || action.index >= tokens.length - 1) return state;
      const current = tokens[action.index];
      const nextToken = tokens[action.index + 1];

      const merged = buildMergedToken([current, nextToken]);
      if (!merged) return state;
      tokens.splice(action.index, 2, merged);
      const nextState: EditorPresentState = { ...state.present, tokens, moveMarkers: deriveMoveMarkers(tokens) };
      return pushPresent(state, nextState);
    }
    case "CANCEL_INSERT_PLACEHOLDER": {
      const [start, end] = action.range;
      const tokens = cloneTokens(state.present.tokens);
      const slice = tokens.slice(start, end + 1);
      const allEmptyInserted = slice.every(
        (t) => t.origin === "inserted" && t.text === "" && (!t.previousTokens || t.previousTokens.length === 0 || isInsertPlaceholder([t]))
      );
      if (!allEmptyInserted) return state;
      tokens.splice(start, slice.length);
      const next: EditorPresentState = { ...state.present, tokens, moveMarkers: deriveMoveMarkers(tokens) };
      // Transient cleanup; do not push to history.
      return { ...state, present: next, future: [] };
    }
    case "MOVE_SELECTED_BY_DRAG": {
      const { fromIndex, toIndex, count } = action; // toIndex is an insertion index (between tokens), 0..length
      if (count <= 0) return state;
      const tokens = cloneTokens(state.present.tokens);
      if (fromIndex < 0 || fromIndex + count > tokens.length) return state;

      let block = tokens.splice(fromIndex, count);
      const originalBlock = cloneTokens(block);
      // Prepare moved block metadata
      const newGroupId = createId();
      const moveId = createId();
      const mid = Math.floor((block.length - 1) / 2);
      block = block.map((tok, idx) =>
        idx === mid
          ? { ...tok, groupId: newGroupId, previousTokens: [makeEmptyPlaceholder([])], origin: tok.origin, moveId }
          : { ...tok, groupId: newGroupId, origin: tok.origin, moveId }
      );

      // Placeholder at old position with earliest history of the block.
      const previousTokens = buildOriginalHistoryForBlock(originalBlock);
      const placeholder = { ...makeEmptyPlaceholder(previousTokens), moveId };

      // Compute insertion index relative to array AFTER removal.
      const insertionIndexAfterRemoval = toIndex > fromIndex ? toIndex - count : toIndex;
      // Insert placeholder at the original position.
      tokens.splice(fromIndex, 0, placeholder);
      // Compute insertion index after placeholder insertion.
      const insertionIndexWithPlaceholder =
        insertionIndexAfterRemoval >= fromIndex ? insertionIndexAfterRemoval + 1 : insertionIndexAfterRemoval;
      const safeInsert = Math.max(0, Math.min(insertionIndexWithPlaceholder, tokens.length));
      tokens.splice(safeInsert, 0, ...block);

      // Placeholder final index shifts right if block inserted before it (leftward move).
      const placeholderIndex = safeInsert <= fromIndex ? fromIndex + block.length : fromIndex;
      const toStart = safeInsert;
      const marker: MoveMarker = {
        id: moveId,
        fromStart: placeholderIndex,
        fromEnd: placeholderIndex,
        toStart,
        toEnd: toStart + count - 1,
      };
      tokens.forEach((tok) => {
        if (tok.moveId === moveId && tok.kind !== "empty") {
          tok.groupId = newGroupId;
        }
      });
      const next: EditorPresentState = { ...state.present, tokens, moveMarkers: deriveMoveMarkers(tokens) };
      return pushPresent(state, next);
    }
    case "UNDO": {
      if (!state.past.length) return state;
      const previous = state.past[state.past.length - 1];
      const past = state.past.slice(0, -1);
      return {
        past,
        present: previous,
        future: [state.present, ...state.future],
      };
    }
    case "REDO": {
      if (!state.future.length) return state;
      const next = state.future[0];
      const future = state.future.slice(1);
      return {
        past: [...state.past, state.present],
        present: next,
        future,
      };
    }
    default:
      return state;
  }
};

export const tokenEditorReducer = reducer;

// ---------------------------
// Token chip rendering helpers
// ---------------------------
const chipBase: React.CSSProperties = {
  padding: "0px",
  display: "inline-flex",
  alignItems: "center",
  gap: 0,
  border: "none",
  background: "transparent",
  transition: "color 0.15s ease, text-decoration 0.15s ease",
};

const chipStyles: Record<string, React.CSSProperties> = {
  word: { ...chipBase, color: "#e2e8f0", padding: "0px 2px" },
  punct: { ...chipBase, color: "#e2e8f0", padding: "0px 2px", gap: 0 },
  special: { ...chipBase, color: "#cbd5e1", borderBottom: "1px dotted rgba(148,163,184,0.8)" },
  empty: { ...chipBase, color: "#cbd5e1" },
  previous: { ...chipBase, color: "#ef4444", fontSize: 12 },
  changed: { color: "#22c55e" },
  selected: {
    background: "rgba(14,165,233,0.15)",
    border: "1px solid rgba(14,165,233,0.6)",
    borderRadius: 10,
  },
};

// Concatenate token texts for editing field and plain-text preview, skipping empty placeholders.
export const buildTextFromTokens = (tokens: Token[]) =>
  tokens
    .filter((t) => t.kind !== "empty")
    .map((t) => t.text)
    .join(" ")
    .replace(/\s+([.,;:?!-])/g, "$1");

export const buildTextFromTokensWithBreaks = (tokens: Token[], breaks: number[]) => {
  const breakSet = new Set(breaks);
  const parts: string[] = [];
  let visibleIdx = 0;
  tokens.forEach((t) => {
    if (t.kind === "empty") return;
    parts.push(t.text);
    visibleIdx += 1;
    if (breakSet.has(visibleIdx)) {
      parts.push("\n");
    }
  });
  const joined = parts.join(" ");
  return joined.replace(/\s+([.,;:?!-])/g, "$1").replace(/\s*\n\s*/g, "\n").trimEnd();
};

export const buildEditableTextFromTokens = (tokens: Token[]) => {
  const visible = tokens.filter((t) => t.kind !== "empty");
  const joined = visible.map((t) => t.text).join(" ");
  return joined.replace(/\s+([.,;:?!])/g, "$1 ").trim();
};

type DiffOp = { type: "equal" | "delete" | "insert"; values: string[] };

const diffTokenSequences = (a: string[], b: string[]): DiffOp[] => {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  const push = (type: DiffOp["type"], values: string[]) => {
    if (!values.length) return;
    const last = ops[ops.length - 1];
    if (last && last.type === type) {
      last.values.push(...values);
    } else {
      ops.push({ type, values: [...values] });
    }
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("equal", [a[i]]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("delete", [a[i]]);
      i += 1;
    } else {
      push("insert", [b[j]]);
      j += 1;
    }
  }
  while (i < a.length) {
    push("delete", [a[i]]);
    i += 1;
  }
  while (j < b.length) {
    push("insert", [b[j]]);
    j += 1;
  }
  return ops;
};

const pickTypeLabel = (labels: Array<string | null | undefined>) => {
  const counts = new Map<string, number>();
  labels.forEach((label) => {
    if (!label) return;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });
  let best: string | null = null;
  let bestCount = -1;
  counts.forEach((count, label) => {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  });
  return best;
};

export const buildM2Preview = ({
  originalTokens,
  tokens,
  correctionCards = [],
  correctionTypeMap = {},
  correctionByIndex,
  resolveTypeLabel,
}: {
  originalTokens: Token[];
  tokens: Token[];
  correctionCards?: Array<{ id: string; rangeStart: number; rangeEnd: number; original: string; updated: string }>;
  correctionTypeMap?: Record<string, number | null | undefined>;
  correctionByIndex?: Map<number, string>;
  resolveTypeLabel?: (typeId: number) => string | null;
}) => {
  const visibleOriginal = originalTokens.filter((t) => t.kind !== "empty").map((t) => t.text);
  const visibleCorrected: string[] = [];
  const typeLabelsForVisible: Array<string | null> = [];
  const tokenIndexToVisible: number[] = [];
  let visibleCounter = 0;

  const resolveType = (typeId: number | null | undefined): string | null => {
    if (typeId === null || typeId === undefined) return null;
    return resolveTypeLabel?.(typeId) ?? String(typeId);
  };

  tokens.forEach((tok, idx) => {
    tokenIndexToVisible[idx] = visibleCounter;
    if (tok.kind === "empty") return;
    visibleCorrected.push(tok.text);
    const cardId = correctionByIndex?.get(idx);
    const typeId = cardId ? correctionTypeMap[cardId] : null;
    typeLabelsForVisible.push(resolveType(typeId));
    visibleCounter += 1;
  });

  const placeholderTypeByInsertion = new Map<number, string | null>();
  tokens.forEach((tok, idx) => {
    if (tok.kind !== "empty") return;
    const insertionIdx = tokenIndexToVisible[idx] ?? 0;
    const cardId = correctionByIndex?.get(idx);
    const typeId = cardId ? correctionTypeMap[cardId] : null;
    if (!placeholderTypeByInsertion.has(insertionIdx)) {
      placeholderTypeByInsertion.set(insertionIdx, resolveType(typeId));
    }
  });

  const cardByInsertion = new Map<number, string>();
  correctionCards.forEach((card) => {
    const insertionIdx = tokenIndexToVisible[card.rangeStart] ?? 0;
    if (!cardByInsertion.has(insertionIdx)) {
      cardByInsertion.set(insertionIdx, card.id);
    }
  });

  const ops = diffTokenSequences(visibleOriginal, visibleCorrected);
  const edits: Array<{ start: number; end: number; startCorr: number; endCorr: number; replacementTokens: string[]; type: string }> = [];
  let origIdx = 0;
  let corrIdx = 0;
  for (let k = 0; k < ops.length; k += 1) {
    const op = ops[k];
    if (op.type === "equal") {
      origIdx += op.values.length;
      corrIdx += op.values.length;
      continue;
    }
    const startOrig = origIdx;
    const startCorr = corrIdx;
    while (k < ops.length && ops[k].type !== "equal") {
      const current = ops[k];
      if (current.type === "delete") {
        origIdx += current.values.length;
      } else if (current.type === "insert") {
        corrIdx += current.values.length;
      }
      k += 1;
    }
    k -= 1; // offset for the for-loop increment
    const endOrig = origIdx;
    const endCorr = corrIdx;
    const replacementTokens = visibleCorrected.slice(startCorr, endCorr);
    const typeFromReplacement = pickTypeLabel(typeLabelsForVisible.slice(startCorr, endCorr));
    let typeLabel =
      typeFromReplacement ??
      placeholderTypeByInsertion.get(startCorr) ??
      (() => {
        const cardId = cardByInsertion.get(startCorr);
        if (!cardId) return null;
        const typeId = correctionTypeMap[cardId];
        return resolveType(typeId);
      })() ??
      "OTHER";
    edits.push({
      start: startOrig,
      end: endOrig,
      startCorr,
      endCorr,
      replacementTokens,
      type: typeLabel ?? "OTHER",
    });
  }

  const lines = [`S ${visibleOriginal.join(" ")}`];
  if (!edits.length) {
    lines.push("A -1 -1|||noop|||-NONE-|||REQUIRED|||-NONE-|||0");
    return lines.join("\n");
  }

  edits.forEach((edit) => {
    const replacement = edit.replacementTokens.length ? edit.replacementTokens.join(" ") : "-NONE-";
    lines.push(`A ${edit.start} ${edit.end}|||${edit.type}|||${replacement}|||REQUIRED|||-NONE-|||0`);
  });
  return lines.join("\n");
};

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export const computeSha256 = async (text: string): Promise<string | null> => {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const data = new TextEncoder().encode(text);
      const digest = await subtle.digest("SHA-256", data);
      return toHex(digest);
    } catch {
      // fall through to node crypto
    }
  }
  try {
    // @ts-ignore - optional in browser
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256");
    hash.update(text);
    return hash.digest("hex");
  } catch {
    return null;
  }
};

export const computeTokensSha256 = async (tokens: string[]): Promise<string | null> => {
  const joined = tokens.join("\u241f");
  return computeSha256(joined);
};

export const annotationsSignature = (annotations: AnnotationDraft[]) => JSON.stringify(annotations);

export const shouldSkipSave = (
  lastSignature: string | null,
  annotations: AnnotationDraft[]
): { skip: boolean; nextSignature: string } => {
  const signature = annotationsSignature(annotations);
  if (signature === lastSignature) {
    return { skip: true, nextSignature: signature };
  }
  if (!annotations.length && lastSignature === null) {
    return { skip: true, nextSignature: signature };
  }
  return { skip: false, nextSignature: signature };
};

type BuildPayloadInput = {
  initialText: string;
  tokens: Token[];
  originalTokens: Token[];
  correctionCards: CorrectionCardLite[];
  correctionTypeMap: Record<string, number | null>;
  moveMarkers: MoveMarker[];
  annotationIdMap?: Map<string, number>;
};

export const buildAnnotationsPayloadStandalone = async ({
  initialText,
  tokens,
  originalTokens,
  correctionCards,
  correctionTypeMap,
  moveMarkers,
  annotationIdMap,
}: BuildPayloadInput): Promise<AnnotationDraft[]> => {
  const textHash = await computeSha256(initialText);
  const textTokensSnapshot = originalTokens.filter((t) => t.kind !== "empty").map((t) => t.text);
  const textTokensHash = await computeTokensSha256(textTokensSnapshot);
  const moveMarkerById = new Map<string, MoveMarker>();
  moveMarkers.forEach((m) => moveMarkerById.set(m.id, m));

  const seenKeys = new Set<string>();
  const payloads: AnnotationDraft[] = [];
  const normalizeBeforeIds = (items: Token[]) => {
    const seen = new Set<string>();
    const ids: string[] = [];
    items.forEach((tok) => {
      if (tok.kind === "empty") return;
      if (seen.has(tok.id)) return;
      seen.add(tok.id);
      ids.push(tok.id);
    });
    return ids;
  };

  const textForIds = (ids: string[]) =>
    ids
      .map((id) => originalTokens.find((t) => t.id === id)?.text ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();

  const fragmentFromToken = (tok: Token): TokenFragmentPayload => ({
    id: tok.id,
    text: tok.text,
    origin: tok.origin === "inserted" ? "inserted" : "base",
    source_id:
      tok.origin === "inserted"
        ? tok.previousTokens?.find((p) => p.kind !== "empty")?.id ?? null
        : tok.id,
  });

  correctionCards.forEach((card) => {
    const typeId = correctionTypeMap[card.id];
    if (!typeId) return;
    const key = `${card.rangeStart}-${card.rangeEnd}-${card.markerId ?? "nomove"}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    let beforeIds: string[] = [];
    let afterFragments: TokenFragmentPayload[] = [];
    let operation: AnnotationDetailPayload["operation"] = "replace";

    if (card.markerId) {
      const marker = moveMarkerById.get(card.markerId);
      if (!marker) return;
      const placeholder = tokens[marker.fromStart];
      const historyTokens = placeholder?.previousTokens
        ? unwindToOriginal(cloneTokens(placeholder.previousTokens))
        : [];
      beforeIds = normalizeBeforeIds(historyTokens);
      afterFragments = tokens
        .slice(marker.toStart, marker.toEnd + 1)
        .filter((tok) => tok.kind !== "empty")
        .map(fragmentFromToken);
      operation = "move";
    } else {
      const historyTokens: Token[] = [];
      for (let idx = card.rangeStart; idx <= card.rangeEnd; idx += 1) {
        const tok = tokens[idx];
        if (tok?.previousTokens?.length) {
          historyTokens.push(...unwindToOriginal(cloneTokens(tok.previousTokens)));
        }
      }
      if (!historyTokens.length) {
        historyTokens.push(
          ...originalTokens.slice(card.rangeStart, card.rangeEnd + 1).filter((tok) => tok.kind !== "empty")
        );
      }
      beforeIds = normalizeBeforeIds(historyTokens);
      afterFragments = tokens
        .slice(card.rangeStart, card.rangeEnd + 1)
        .filter((tok) => tok.kind !== "empty")
        .map(fragmentFromToken);
      const beforeText = textForIds(beforeIds);
      const afterText = afterFragments.map((f) => f.text).join(" ").trim();
      if (!afterFragments.length || afterText === "") {
        operation = "delete";
      } else if (!beforeIds.length) {
        operation = "insert";
      } else if (beforeText === afterText) {
        operation = "noop";
      } else {
        operation = "replace";
      }
    }

    const replacement = afterFragments.length === 0 ? null : afterFragments.map((f) => f.text).join(" ").trim() || null;

    const payload: AnnotationDetailPayload = {
      text_sha256: textHash,
      text_tokens: textTokensSnapshot,
      text_tokens_sha256: textTokensHash ?? undefined,
      operation,
      before_tokens: beforeIds,
      after_tokens: afterFragments,
      source: "manual",
    };

    const draft: AnnotationDraft = {
      start_token: card.rangeStart,
      end_token: card.rangeEnd,
      replacement,
      error_type_id: typeId,
      payload,
    };
    const spanKey = `${card.rangeStart}-${card.rangeEnd}`;
    const existingId = annotationIdMap?.get(spanKey);
    if (existingId !== undefined) {
      draft.id = existingId;
    }
    payloads.push(draft);
  });

  return payloads;
};
// ---------------------------
// Component
// ---------------------------
type SelectionRange = { start: number | null; end: number | null };

export type SaveStatus = { state: "idle" | "saving" | "saved" | "error"; unsaved: boolean };

const PREFS_KEY = "tokenEditorPrefs";

type CorrectionCardLite = {
  id: string;
  rangeStart: number;
  rangeEnd: number;
  markerId: string | null;
};

const loadPrefs = (): {
  sidebarOpen?: boolean;
  tokenGap?: number;
  tokenFontSize?: number;
  lastDecision?: "skip" | "trash" | "submit" | null;
  lastTextId?: number;
  viewTab?: "original" | "corrected" | "m2";
  textPanelOpen?: boolean;
  debugOpen?: boolean;
} => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const typeKey = (textId: number) => `${PREFS_KEY}:types:${textId}`;

const loadCorrectionTypes = (
  textId: number
): { activeErrorTypeId: number | null; assignments: Record<string, number | null> } => {
  try {
    const raw = localStorage.getItem(typeKey(textId));
    if (!raw) return { activeErrorTypeId: null, assignments: {} };
    const parsed = JSON.parse(raw);
    return {
      activeErrorTypeId: typeof parsed?.activeErrorTypeId === "number" ? parsed.activeErrorTypeId : null,
      assignments: typeof parsed?.assignments === "object" && parsed.assignments ? parsed.assignments : {},
    };
  } catch {
    return { activeErrorTypeId: null, assignments: {} };
  }
};

const persistCorrectionTypes = (
  textId: number,
  payload: { activeErrorTypeId: number | null; assignments: Record<string, number | null> }
) => {
  try {
    localStorage.setItem(typeKey(textId), JSON.stringify(payload));
  } catch {
    // ignore
  }
};

const stateKey = (textId: number) => `${PREFS_KEY}:state:${textId}`;

const loadEditorState = (textId: number): EditorPresentState | null => {
  try {
    const raw = localStorage.getItem(stateKey(textId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.originalTokens || !parsed?.tokens || !parsed?.moveMarkers) return null;
    return parsed as EditorPresentState;
  } catch {
    return null;
  }
};

const persistEditorState = (textId: number, state: EditorPresentState) => {
  try {
    localStorage.setItem(stateKey(textId), JSON.stringify(state));
  } catch {
    // ignore
  }
};

export const TokenEditor: React.FC<{
  initialText: string;
  textId: number;
  categoryId: number;
  onSaveStatusChange?: (status: SaveStatus) => void;
}> = ({
  initialText,
  textId,
  categoryId,
  onSaveStatusChange,
}) => {
  const { t, locale } = useI18n();
  const api = useAuthedApi();
  const navigate = useNavigate();
  const location = useLocation();

  const [history, dispatch] = useReducer(reducer, {
    past: [],
    present: { originalTokens: [], tokens: [], moveMarkers: [] },
    future: [],
  });

  // Selection and editing UI state (kept outside history).
  const [selection, setSelection] = useState<SelectionRange>({ start: null, end: null });
  const [editingRange, setEditingRange] = useState<SelectionRange | null>(null);
  const [editText, setEditText] = useState("");
  const prefs = useMemo(() => loadPrefs(), []);
const [tokenGap, setTokenGap] = useState(prefs.tokenGap ?? 2);
const [tokenFontSize, setTokenFontSize] = useState(prefs.tokenFontSize ?? 16);
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null); // insertion position 0..tokens.length
  const tokenRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const measureTextWidth = useCallback(
    (text: string) => {
      let canvas = measureCanvasRef.current;
      if (!canvas) {
        canvas = document.createElement("canvas");
        measureCanvasRef.current = canvas;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return text.length * tokenFontSize * 0.65;
      ctx.font = `${tokenFontSize}px Inter, system-ui, -apple-system, sans-serif`;
      return ctx.measureText(text || "").width;
    },
    [tokenFontSize]
  );
  const groupRefs = useRef<Record<number, HTMLDivElement | null>>({});
const tokenRowRef = useRef<HTMLDivElement | null>(null);
const [isSidebarOpen, setIsSidebarOpen] = useState(prefs.sidebarOpen ?? true);
const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSkipping, setIsSkipping] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isAutosaving, setIsAutosaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
const initialViewTab = useMemo<"original" | "corrected" | "m2">(() => {
  if (prefs.viewTab === "original" || prefs.viewTab === "corrected" || prefs.viewTab === "m2") {
    return prefs.viewTab;
  }
  return "corrected";
}, [prefs.viewTab]);
const [viewTab, setViewTab] = useState<"original" | "corrected" | "m2">(initialViewTab);
const [isTextPanelOpen, setIsTextPanelOpen] = useState<boolean>(prefs.textPanelOpen ?? true);
const [lineBreaks, setLineBreaks] = useState<number[]>([]);
const lineBreakSet = useMemo(() => new Set(lineBreaks), [lineBreaks]);
const [isDebugOpen, setIsDebugOpen] = useState(prefs.debugOpen ?? false);
  const autosaveInitializedRef = useRef(false);
  const lastSavedSignatureRef = useRef<string | null>(null);
  const [lastDecision, setLastDecision] = useState<"skip" | "trash" | "submit" | null>(
    prefs.lastTextId === textId ? prefs.lastDecision ?? null : null
  );
  const [pendingAction, setPendingAction] = useState<"skip" | "trash" | null>(null);
  const [flagReason, setFlagReason] = useState("");
  const [flagError, setFlagError] = useState<string | null>(null);
  const [isHoveringMove, setIsHoveringMove] = useState(false);
  const [hoveredMoveId, setHoveredMoveId] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [hoveredCorrectionRange, setHoveredCorrectionRange] = useState<[number, number] | null>(null);
  const [errorTypes, setErrorTypes] = useState<ErrorType[]>([]);
  const [isLoadingErrorTypes, setIsLoadingErrorTypes] = useState(false);
  const [errorTypesError, setErrorTypesError] = useState<string | null>(null);
  const [activeErrorTypeId, setActiveErrorTypeId] = useState<number | null>(null);
  const [correctionTypeMap, setCorrectionTypeMap] = useState<Record<string, number | null>>({});
  const [hasLoadedTypeState, setHasLoadedTypeState] = useState(false);
  const [serverAnnotationVersion, setServerAnnotationVersion] = useState(0);
  const annotationIdMap = useRef<Map<string, number>>(new Map());
  const prevCorrectionCountRef = useRef(0);
  const handleRevert = (rangeStart: number, rangeEnd: number, markerId: string | null = null) => {
    dispatch({ type: "REVERT_CORRECTION", rangeStart, rangeEnd, markerId });
    setSelection({ start: null, end: null });
    setEditingRange(null);
  };

  const tokens = history.present.tokens;
  const originalTokens = history.present.originalTokens;
  const baseTokenMap = useMemo(() => {
    const map = new Map<string, Token>();
    originalTokens.forEach((tok) => {
      if (tok.kind !== "empty") {
        map.set(tok.id, tok);
      }
    });
    return map;
  }, [originalTokens]);
  const textForIds = useCallback(
    (ids: string[]) =>
      ids
        .map((id) => baseTokenMap.get(id)?.text ?? "")
        .filter(Boolean)
        .join(" ")
        .trim(),
    [baseTokenMap]
  );
  const toFragment = useCallback(
    (tok: Token): TokenFragmentPayload => ({
      id: tok.id,
      text: tok.text,
      origin: tok.origin === "inserted" ? "inserted" : "base",
      source_id:
        tok.origin === "inserted"
          ? tok.previousTokens?.find((p) => p.kind !== "empty")?.id ?? null
          : tok.id,
    }),
    []
  );

  const formatError = useCallback((error: any): string => {
    const detail = error?.response?.data?.detail ?? error?.message ?? String(error);
    if (typeof detail === "string") return detail;
    try {
      return JSON.stringify(detail);
    } catch {
      return String(detail);
    }
  }, []);

  const getRangeRect = (start: number, end: number) => {
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(tokens.length - 1, end);
    let minLeft = Number.POSITIVE_INFINITY;
    let minTop = Number.POSITIVE_INFINITY;
    let maxRight = Number.NEGATIVE_INFINITY;
    let maxBottom = Number.NEGATIVE_INFINITY;
    for (let i = safeStart; i <= safeEnd; i += 1) {
      const tok = tokens[i];
      if (!tok) continue;
      const el = tokenRefs.current[tok.id];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      minLeft = Math.min(minLeft, rect.left);
      minTop = Math.min(minTop, rect.top);
      maxRight = Math.max(maxRight, rect.right);
      maxBottom = Math.max(maxBottom, rect.bottom);
    }
    if (!Number.isFinite(minLeft) || !tokenRowRef.current) return null;
    const containerRect = tokenRowRef.current.getBoundingClientRect();
    return {
      left: minLeft - containerRect.left,
      top: minTop - containerRect.top,
      right: maxRight - containerRect.left,
      bottom: maxBottom - containerRect.top,
      width: maxRight - minLeft,
      height: maxBottom - minTop,
    };
  };

  // Recompute move arrows directly in render using current DOM positions.

  // Derived helpers
  const hasSelection = selection.start !== null && selection.end !== null;
  const selectedIndices = useMemo(() => {
    if (!hasSelection) return [];
    const [s, e] = [selection.start!, selection.end!];
    const start = Math.min(s, e);
    const end = Math.max(s, e);
    return rangeToArray([start, end]);
  }, [selection, hasSelection]);

  // Init from text on mount.
  useEffect(() => {
    setHasLoadedTypeState(false);
    setActiveErrorTypeId(null);
    setCorrectionTypeMap({});
    setServerAnnotationVersion(0);
  }, [textId]);

  useEffect(() => {
    const saved = loadEditorState(textId);
    if (saved) {
      dispatch({ type: "INIT_FROM_STATE", state: saved });
    } else {
      dispatch({ type: "INIT_FROM_TEXT", text: initialText });
    }
    const typeState = loadCorrectionTypes(textId);
    setActiveErrorTypeId(typeState.activeErrorTypeId);
    setCorrectionTypeMap(typeState.assignments);
    setHasLoadedTypeState(true);
    lastSavedSignatureRef.current = null;
  }, [initialText, textId]);

  useEffect(() => {
    const computeBreaks = (text: string) => {
      const breaks: number[] = [];
      const lines = text.split(/\n/);
      let count = 0;
      lines.forEach((line, idx) => {
        const lineTokens = tokenizeToTokens(line);
        count += lineTokens.filter((t) => t.kind !== "empty").length;
        if (idx < lines.length - 1) {
          breaks.push(count);
        }
      });
      return breaks;
    };
    setLineBreaks(computeBreaks(initialText));
  }, [initialText]);

  useEffect(() => {
    let cancelled = false;
    const loadExistingAnnotations = async () => {
      try {
        const res = await api.get(`/api/texts/${textId}/annotations`);
        if (cancelled) return;
        const items = Array.isArray(res.data) ? res.data : [];
        const maxVersion = items.reduce((acc: number, ann: any) => Math.max(acc, ann?.version ?? 0), 0);
        setServerAnnotationVersion(maxVersion);
        annotationIdMap.current = new Map<string, number>();
        items.forEach((ann: any) => {
          if (ann?.id != null && typeof ann.start_token === "number" && typeof ann.end_token === "number") {
            const key = `${ann.start_token}-${ann.end_token}`;
            annotationIdMap.current.set(key, ann.id);
          }
        });
      } catch {
        // ignore load errors; optimistic saves will still work
      }
    };
    loadExistingAnnotations();
    return () => {
      cancelled = true;
    };
  }, [api, textId]);

  useEffect(() => {
    try {
      localStorage.setItem("lastAnnotationPath", location.pathname);
    } catch {
      // ignore
    }
  }, [location.pathname]);

  // Update selection highlight by toggling selected flag (not stored in history).
  const selectedSet = useMemo(() => new Set(selectedIndices), [selectedIndices]);
  const hoveredSet = useMemo(() => {
    if (!hoveredCorrectionRange) return new Set<number>();
    const [s, e] = hoveredCorrectionRange;
    return new Set(rangeToArray([s, e]));
  }, [hoveredCorrectionRange]);

  const activeErrorTypes = useMemo(
    () => errorTypes.filter((type) => type.is_active),
    [errorTypes]
  );

  const groupedErrorTypes = useMemo(() => {
    const groups = new Map<string, { label: string; items: ErrorType[] }>();
    activeErrorTypes.forEach((type) => {
      const label =
        getErrorTypeSuperLabel(type, locale) || type.category_en || t("tokenEditor.categories");
      const key = label || type.id.toString();
      const bucket = groups.get(key) ?? { label, items: [] };
      bucket.items.push(type);
      groups.set(key, bucket);
    });
    return Array.from(groups.values());
  }, [activeErrorTypes, locale, t]);

  const correctionCards = useMemo(() => {
    const movePlaceholderIndices = new Set(history.present.moveMarkers.map((m) => m.fromStart));
    const moveDestIndices = new Set<number>();
    history.present.moveMarkers.forEach((m) => {
      for (let i = m.toStart; i <= m.toEnd; i += 1) {
        moveDestIndices.add(i);
      }
    });
    const visited = new Set<number>();

    const findGroupRange = (idx: number): [number, number] => {
      const tok = tokens[idx];
      if (!tok) return [idx, idx];
      if (!tok.groupId) return [idx, idx];
      let l = idx;
      let r = idx;
      while (l - 1 >= 0 && tokens[l - 1]?.groupId === tok.groupId) l -= 1;
      while (r + 1 < tokens.length && tokens[r + 1]?.groupId === tok.groupId) r += 1;
      return [l, r];
    };

    const tokenCards = tokens
      .map((tok, idx) => {
        if (visited.has(idx)) return null;
        if (!tok.previousTokens?.length) return null;
        if (movePlaceholderIndices.has(idx)) return null; // move will be shown as a single correction card
        if (moveDestIndices.has(idx)) return null; // avoid duplicate move card; handled separately
        const [rangeStart, rangeEnd] = findGroupRange(idx);
        for (let i = rangeStart; i <= rangeEnd; i += 1) visited.add(i);
        return {
          id: tok.id,
          title: `Item (${rangeStart + 1}-${rangeEnd + 1})`,
          original: tok.previousTokens.map((p) => p.text).join(" "),
          updated: tokens.slice(rangeStart, rangeEnd + 1).map((t) => t.text).join(" "),
          range: rangeStart === rangeEnd ? `${rangeStart + 1}` : `${rangeStart + 1}-${rangeEnd + 1}`,
          rangeStart,
          rangeEnd,
          markerId: null,
        };
      })
      .filter(Boolean) as Array<{
        id: string;
        title: string;
        original: string;
        updated: string;
        range: string;
        rangeStart: number;
        rangeEnd: number;
        markerId: string | null;
      }>;

    const moveCards = history.present.moveMarkers
      .map((marker) => {
        const placeholder = tokens[marker.fromStart];
        const oldTokens = placeholder?.previousTokens ?? [];
        const newTokens = tokens.slice(marker.toStart, marker.toEnd + 1);
        return {
          id: marker.id,
          title: `Move ${marker.fromStart + 1}-${marker.fromEnd + 1} → ${marker.toStart + 1}-${marker.toEnd + 1}`,
          original: oldTokens.length ? oldTokens.map((t) => t.text).join(" ") : "⬚",
          updated: newTokens.map((t) => t.text).join(" ") || "⬚",
          range: `${marker.toStart + 1}-${marker.toEnd + 1}`,
          rangeStart: marker.toStart,
          rangeEnd: marker.toEnd,
          markerId: marker.id,
        };
      })
      .filter(Boolean);

    return [...tokenCards, ...moveCards];
  }, [tokens, history.present.moveMarkers]);

  const correctionByIndex = useMemo(() => {
    const map = new Map<number, string>();
    correctionCards.forEach((card) => {
      for (let i = card.rangeStart; i <= card.rangeEnd; i += 1) {
        map.set(i, card.id);
      }
    });
    return map;
  }, [correctionCards]);
  const moveMarkerById = useMemo(() => {
    const map = new Map<string, MoveMarker>();
    history.present.moveMarkers.forEach((m) => map.set(m.id, m));
    return map;
  }, [history.present.moveMarkers]);

  const requestNextText = useCallback(async () => {
    try {
      const response = await api.post("/api/texts/assignments/next", null, {
        params: { category_id: categoryId },
      });
      const nextId = response.data?.text?.id;
      if (nextId && nextId !== textId) {
        navigate(`/annotate/${nextId}`);
        return true;
      }
      return false;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404) {
        try {
          const categories = await api.get("/api/categories/");
          const current = (categories.data as Array<{ id: number; remaining_texts: number }>).find(
            (c) => c.id === categoryId,
          );
          if (current && current.remaining_texts > 0) {
            setActionMessage(t("categories.noTextsAvailableNow") ?? "No texts available right now. Please try again.");
          } else {
            setActionMessage(t("categories.noTexts") ?? "No texts left in this category.");
          }
        } catch {
          setActionMessage(t("categories.noTexts") ?? "No texts left in this category.");
        }
      } else {
        setActionError(formatError(error));
      }
    }
    return false;
  }, [api, categoryId, navigate, t, textId]);

  useEffect(() => {
    let cancelled = false;
    const loadErrorTypes = async () => {
      setIsLoadingErrorTypes(true);
      setErrorTypesError(null);
      try {
        const response = await api.get("/api/error-types/");
        if (!cancelled) {
          setErrorTypes(response.data as ErrorType[]);
        }
      } catch (error: any) {
        if (!cancelled) {
          setErrorTypesError(formatError(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingErrorTypes(false);
        }
      }
    };
    loadErrorTypes();
    return () => {
      cancelled = true;
    };
  }, [api, formatError]);

  const handleFlag = useCallback((flagType: "skip" | "trash") => {
    setActionError(null);
    setActionMessage(null);
    setPendingAction(flagType);
    setFlagReason("");
    setFlagError(null);
  }, []);

  const confirmFlag = useCallback(async () => {
    if (!pendingAction) return;
    const flagType = pendingAction;
    setActionError(null);
    setActionMessage(null);
    setFlagError(null);
    flagType === "skip" ? setIsSkipping(true) : setIsTrashing(true);
    let succeeded = false;
    try {
      const reason = flagReason.trim();
      await api.post(`/api/texts/${textId}/${flagType}`, { reason: reason || undefined });
      setActionMessage(flagType === "skip" ? t("annotation.skipText") : t("annotation.trashText"));
      setLastDecision(flagType);
      await requestNextText();
      succeeded = true;
    } catch (error: any) {
      setFlagError(formatError(error));
    } finally {
      flagType === "skip" ? setIsSkipping(false) : setIsTrashing(false);
      if (succeeded) {
        setPendingAction(null);
        setFlagReason("");
      }
    }
  }, [api, flagReason, navigate, pendingAction, requestNextText, t, textId]);

  const cancelFlag = useCallback(() => {
    setPendingAction(null);
    setFlagReason("");
    setFlagError(null);
  }, []);

  // Enter edit mode from selection.
  const beginEdit = (range?: { start: number; end: number }, caretIndex?: number) => {
    const activeRange = range ?? (hasSelection ? { start: Math.min(selection.start!, selection.end!), end: Math.max(selection.start!, selection.end!) } : null);
    if (!activeRange) return;
    const slice = tokens.slice(activeRange.start, activeRange.end + 1);
    // Do not allow editing if any ⬚ token is in the selection.
    if (slice.some((tok) => tok.kind === "empty" || tok.kind === "special")) {
      return;
    }
    setEditingRange(activeRange);
    const editValue = buildEditableTextFromTokens(slice);
    setEditText(editValue);
    const desiredCaret = typeof caretIndex === "number" ? caretIndex : editValue.length;
    setTimeout(() => {
      if (editInputRef.current) {
        const target = editInputRef.current;
        const pos = Math.max(0, Math.min(desiredCaret, target.value.length));
        target.focus();
        if (typeof target.setSelectionRange === "function") {
          target.setSelectionRange(pos, pos);
        }
      }
    }, 10);
  };

  // Commit edit.
  const commitEdit = () => {
    if (!editingRange) return;
    const { start, end } = editingRange;
    dispatch({ type: "EDIT_SELECTED_RANGE_AS_TEXT", range: [start!, end!], newText: editText });
    setEditingRange(null);
    setSelection({ start, end });
  };

  // Cancel edit.
  const cancelEdit = () => {
    if (editingRange) {
      const s = Math.min(editingRange.start!, editingRange.end!);
      const e = Math.max(editingRange.start!, editingRange.end!);
      const slice = tokens.slice(s, e + 1);
      if (isInsertPlaceholder(slice)) {
        // Cancel the insertion entirely without leaving a redo entry.
        dispatch({ type: "CANCEL_INSERT_PLACEHOLDER", range: [s, e] });
      }
    }
    setEditingRange(null);
    setEditText("");
  };

  // Selection click logic with contiguous Ctrl-select.
  const handleTokenClick = (index: number, ctrlKey: boolean) => {
    if (tokens[index]?.kind === "special") return;
    if (!ctrlKey) {
      setSelection({ start: index, end: index });
      return;
    }
    if (!hasSelection) {
      setSelection({ start: index, end: index });
      return;
    }
    const [s, e] = [selection.start!, selection.end!];
    const start = Math.min(s, e, index);
    const end = Math.max(s, e, index);
    setSelection({ start, end });
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || (target as HTMLInputElement).isContentEditable);
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const isUndoKey = ctrlOrMeta && key === "z" && !event.shiftKey;
      const isRedoKey = ctrlOrMeta && (key === "y" || (event.shiftKey && key === "z"));
      if (editingRange) {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelEdit();
          setSelection({ start: null, end: null });
        } else if (event.key === "Enter") {
          event.preventDefault();
          commitEdit();
        }
        return;
      }
      if (showClearConfirm && event.key === "Escape") {
        event.preventDefault();
        setShowClearConfirm(false);
        return;
      }
      if (pendingAction && event.key === "Escape") {
        event.preventDefault();
        cancelFlag();
        return;
      }
      if (showClearConfirm && event.key === "Escape") {
        event.preventDefault();
        setShowClearConfirm(false);
        return;
      }
      if (isInput && !(isUndoKey || isRedoKey)) return;
      if (isUndoKey) {
        event.preventDefault();
        dispatch({ type: "UNDO" });
        return;
      }
      if (isRedoKey) {
        event.preventDefault();
        dispatch({ type: "REDO" });
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (hasSelection) {
          event.preventDefault();
          const [s, e] = [selection.start!, selection.end!];
          dispatch({ type: "DELETE_SELECTED_TOKENS", range: [Math.min(s, e), Math.max(s, e)] });
          setSelection({ start: null, end: null });
        }
      }
      if (event.key === "Insert") {
        if (!hasSelection) return;
        event.preventDefault();
        const [s, e] = [selection.start!, selection.end!];
        const start = Math.min(s, e);
        const end = Math.max(s, e);
        dispatch({ type: "INSERT_TOKEN_AFTER_SELECTED", range: [start, end] });
        // prepare to edit the new token
        const newIndex = end + 1;
        setSelection({ start: newIndex, end: newIndex });
        setEditingRange({ start: newIndex, end: newIndex });
        setEditText("");
        setTimeout(() => editInputRef.current?.focus(), 10);
      }
      if (event.key === "Escape") {
        setSelection({ start: null, end: null });
      }
      if (event.key === "Enter" && hasSelection) {
        event.preventDefault();
        beginEdit(undefined, editText.length);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editingRange, hasSelection, selection, showClearConfirm, pendingAction, cancelFlag]);

  // Drag & drop support for moving selected block.
  const dragInfoRef = useRef<{ fromIndex: number; count: number } | null>(null);
  const handleDragStart = (index: number, evt: React.DragEvent) => {
    const expandGroup = (idx: number): [number, number] => {
      const tok = tokens[idx];
      if (!tok?.groupId) return [idx, idx];
      let l = idx;
      let r = idx;
      while (l - 1 >= 0 && tokens[l - 1]?.groupId === tok.groupId) l -= 1;
      while (r + 1 < tokens.length && tokens[r + 1]?.groupId === tok.groupId) r += 1;
      return [l, r];
    };

    let rangeStart = hasSelection && selectedSet.has(index) ? Math.min(selection.start!, selection.end!) : index;
    let rangeEnd = hasSelection && selectedSet.has(index) ? Math.max(selection.start!, selection.end!) : index;

    // If the token belongs to a group (edited/replaced), move the whole group.
    const [gStart, gEnd] = expandGroup(index);
    rangeStart = Math.min(rangeStart, gStart);
    rangeEnd = Math.max(rangeEnd, gEnd);

    if (!hasSelection || !selectedSet.has(index)) {
      // If nothing (or other block) is selected, start with the group selection.
      setSelection({ start: rangeStart, end: rangeEnd });
    }

    const slice = tokens.slice(rangeStart, rangeEnd + 1);
    // Block moving pure inserted groups or pure deletion placeholders.
    const allInserted = slice.every((t) => t.origin === "inserted");
    const allDeletionPlaceholder = slice.every((t) => t.kind === "empty" && t.previousTokens && t.previousTokens.length);
    if (allInserted || allDeletionPlaceholder) {
      dragInfoRef.current = null;
      evt.preventDefault();
      return;
    }

    const count = rangeEnd - rangeStart + 1;
    dragInfoRef.current = { fromIndex: rangeStart, count };
    // Required by some browsers to allow drop.
    evt.dataTransfer.setData("text/plain", "moving-tokens");
    // Ghost preview with selected text
    const ghost = document.createElement("div");
    ghost.textContent = selectedIndices.map((i) => tokens[i]?.text).filter(Boolean).join(" ");
    ghost.style.position = "absolute";
    ghost.style.top = "-9999px";
    ghost.style.left = "-9999px";
    ghost.style.padding = "6px 10px";
    ghost.style.background = "rgba(30,41,59,0.9)";
    ghost.style.color = "#e2e8f0";
    ghost.style.border = "1px solid rgba(148,163,184,0.6)";
    ghost.style.borderRadius = "10px";
    document.body.appendChild(ghost);
    // Use the created element as drag image
    evt.dataTransfer.setDragImage(ghost, 10, 10);
    setTimeout(() => document.body.removeChild(ghost), 0);
  };
  const handleDrop = (targetIndex: number) => {
    const info = dragInfoRef.current;
    dragInfoRef.current = null;
    setDropTargetIndex(null);
    if (!info) return;
    const { fromIndex, count } = info;
    const start = fromIndex;
    const end = fromIndex + count - 1;
    // Ignore drops inside the same block (no movement).
    if (targetIndex >= start && targetIndex <= end + 1) return;
    dispatch({ type: "MOVE_SELECTED_BY_DRAG", fromIndex, toIndex: targetIndex, count });
    // After moving, clear selection so the moved tokens don't show a background.
    setSelection({ start: null, end: null });
    setEditingRange(null);
  };

  const renderToken = (token: Token, index: number, forceChanged = false) => {
    const isSelected = selectedSet.has(index);
    const hasHistory = forceChanged || Boolean(token.previousTokens?.length);
    const isSpecial = token.kind === "special";
    const isEmpty = token.kind === "empty";
    const displayText =
      isEmpty
        ? "⬚"
        : isSpecial && token.text.length > 32
          ? `${token.text.slice(0, 18)}…${token.text.slice(-10)}`
          : token.text;
    // const specialMaxWidth = isSpecial
    //   ? Math.max(72, Math.min(140, displayText.length * tokenFontSize * 0.35))
    //   : undefined;
    // const specialPadY = Math.max(0, tokenFontSize * 0.03);
    // const specialPadX = Math.max(0.5, tokenFontSize * 0.12);

    const style: React.CSSProperties = {
      ...(chipStyles[token.kind] || chipBase),
      ...(hasHistory ? chipStyles.changed : {}),
      cursor: isSpecial || isEmpty ? "default" : "pointer",
      userSelect: "none",
      position: "relative",
      fontSize: tokenFontSize,
      padding: 0,
      lineHeight: 1.05,
      marginRight: 0,
    };
    if (isEmpty) {
      Object.assign(style, {
        color: "#94a3b8",
        border: "1px dashed rgba(148,163,184,0.5)",
        borderRadius: 8,
        background: "rgba(15,23,42,0.15)",
        padding: "2px 6px",
      });
    }
    if (isSelected) {
      Object.assign(style, chipStyles.selected);
    }
    const isEditingChip =
      editingRange &&
      index >= Math.min(editingRange.start!, editingRange.end!) &&
      index <= Math.max(editingRange.start!, editingRange.end!);
    if (isEditingChip) {
      // Render one pill covering the whole selected span only on the first token of the span.
      if (index !== Math.min(editingRange!.start!, editingRange!.end!)) return null;
      const editStart = Math.min(editingRange!.start!, editingRange!.end!);
      const editEnd = Math.max(editingRange!.start!, editingRange!.end!);
      const originalSelection = tokens.slice(editStart, editEnd + 1).map((t) => t.text).join(" ");
      const textForWidth = editText.length ? editText : originalSelection;
      const measuredPx = measureTextWidth(textForWidth);
      const editPxWidth = Math.max(48, Math.min(800, measuredPx + tokenFontSize * 1.5)); // padding headroom
      const selectedHighlight = chipStyles.selected;
      return (
        <div
          key={`edit-${index}`}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            padding: "6px 8px",
            borderRadius: 10,
            border: "1px solid rgba(148,163,184,0.25)",
            flex: "0 0 auto",
          }}
        >
          <div
            style={{
              ...style,
              ...selectedHighlight,
              background: "rgba(59,130,246,0.12)",
              width: `${editPxWidth}px`,
              minWidth: `${editPxWidth}px`,
              maxWidth: `${editPxWidth}px`,
              flex: "0 0 auto",
            }}
          >
            <input
              ref={editInputRef as React.RefObject<HTMLInputElement>}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#e4f4ec",
              }}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                  setSelection({ start: null, end: null });
                }
              }}
              autoFocus
              placeholder={t("tokenEditor.editPlaceholder")}
            />
          </div>
        </div>
      );
    }
    const dropHighlight = dropTargetIndex !== null && dropTargetIndex === index && !editingRange;
    const caretHint = dropHighlight
      ? {
          position: "absolute" as const,
          left: -4,
          top: -8,
          bottom: -8,
          width: 2,
          background: "rgba(94,234,212,0.8)",
          boxShadow: "0 0 0 1px rgba(94,234,212,0.5)",
        }
      : null;

    return (
      <div
        key={token.id}
        style={style}
        draggable={!isSpecial && !isEmpty}
        onDragStart={(e) => {
          if (isSpecial || isEmpty) return;
          handleDragStart(index, e);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const relative = (e.clientX - rect.left) / Math.max(rect.width, 1);
          const targetIdx = relative > 0.5 ? index + 1 : index;
          setDropTargetIndex(targetIdx);
        }}
        onDrop={(e) => {
          e.preventDefault();
          handleDrop(dropTargetIndex ?? index);
        }}
        onClick={(e) => {
          if (isSpecial || isEmpty) return;
          handleTokenClick(index, e.ctrlKey || e.metaKey);
        }}
        onDoubleClick={(e) => {
          if (isSpecial || isEmpty) return;
          // Expand to the whole group (same groupId) when starting an edit.
          const gid = token.groupId;
          let l = index;
          let r = index;
          if (gid) {
            while (l - 1 >= 0 && tokens[l - 1]?.groupId === gid) l -= 1;
            while (r + 1 < tokens.length && tokens[r + 1]?.groupId === gid) r += 1;
          }
          const range = { start: l, end: r };
          setSelection(range);
          // Approximate caret based on click position within the token box.
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const relative = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(rect.width, 1)));
          const caret = Math.round(relative * token.text.length);
          beginEdit(range, caret);
        }}
        title={token.kind === "empty" ? "Empty placeholder" : token.text}
        ref={(el) => {
          tokenRefs.current[token.id] = el;
        }}
        aria-pressed={isSelected}
      >
        <span>{displayText}</span>
        {caretHint && <span style={caretHint} />}
      </div>
    );
  };

  // Render tokens grouped by groupId so corrected clusters share one border and centered history.
  const renderTokenGroups = (tokenList: Token[]) => {
    const groups: { tokens: Token[]; start: number; end: number }[] = [];
    let visibleCount = 0;
    let idx = 0;
    while (idx < tokenList.length) {
      const current = tokenList[idx];
      if (current.groupId) {
        let end = idx;
        while (end + 1 < tokenList.length && tokenList[end + 1].groupId === current.groupId) {
          end += 1;
        }
        groups.push({ tokens: tokenList.slice(idx, end + 1), start: idx, end });
        idx = end + 1;
      } else {
        groups.push({ tokens: [current], start: idx, end: idx });
        idx += 1;
      }
    }

    const activeMarker = history.present.moveMarkers[0] ?? null;
    const hoveredMarker = hoveredMoveId
      ? history.present.moveMarkers.find((m) => m.id === hoveredMoveId) ?? null
      : null;
    const destSet =
      activeMarker && activeMarker.toStart >= 0 && activeMarker.toEnd >= activeMarker.toStart
        ? new Set(rangeToArray([activeMarker.toStart, activeMarker.toEnd]))
        : new Set<number>();

    const renderGap = (idx: number) => {
      const base = Math.max(0, tokenGap);
      const nextTok = tokens[idx];
      const gapWidth = nextTok?.kind === "punct" ? Math.floor(base * 0.2) : base;
      return (
        <div
          key={`gap-${idx}`}
          style={{
            width: gapWidth,
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDropTargetIndex(idx);
          }}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(idx);
          }}
        >
        </div>
      );
    };

    const result: React.ReactNode[] = [renderGap(0)];

    groups.forEach((group, groupIndex) => {
      const hasHistory = group.tokens.some((t) => t.previousTokens?.length);
      const anchorToken =
        group.tokens.find((t) => t.previousTokens?.length) ?? group.tokens[Math.floor(group.tokens.length / 2)];
      const historyTokens = anchorToken.previousTokens ?? [];
      const historyTextLen = historyTokens.reduce((acc, prev, i) => acc + prev.text.length + (i ? 1 : 0), 0);
      const correctedLen = group.tokens.reduce((acc, tok) => {
        if (tok.kind === "empty") return acc;
        const visibleLen = tok.kind === "special" ? Math.min(tok.text.length, 28) : tok.text.length;
        return acc + visibleLen + 1;
      }, 0);
      const cardId = correctionByIndex.get(group.start) ?? correctionByIndex.get(group.end);
      const typeId = cardId ? correctionTypeMap[cardId] ?? null : null;
      const typeObj = typeId ? errorTypeById.get(typeId) ?? null : null;
      const badgeText = typeObj ? getErrorTypeLabel(typeObj, locale) : "";
      const badgeWidthEstimate = badgeText.length ? badgeText.length * 8 + 24 : 0;
      const minWidth = Math.max(24, correctedLen * 8, historyTextLen * 8, badgeWidthEstimate);
      // Update visible counter for line breaks (count only rendered tokens).
      group.tokens.forEach((tok) => {
        if (tok.kind !== "empty") visibleCount += 1;
      });
    const isMoveSource =
      activeMarker &&
      group.start <= activeMarker.fromEnd &&
      group.end >= activeMarker.fromStart;
      const isMoveDest =
        activeMarker &&
        group.start <= activeMarker.toEnd &&
        group.end >= activeMarker.toStart;
      const showBorder = hasHistory || Boolean(isMoveDest);
      const matchingMarker =
        history.present.moveMarkers.find(
          (m) =>
            (group.start >= m.fromStart && group.start <= m.fromEnd) ||
            (group.start >= m.toStart && group.start <= m.toEnd)
        ) ?? null;
      const isHoveredGroup =
        (hoveredCorrectionRange &&
          !(group.end < hoveredCorrectionRange[0] || group.start > hoveredCorrectionRange[1])) ||
        (hoveredMarker &&
          ((group.start >= hoveredMarker.fromStart && group.start <= hoveredMarker.fromEnd) ||
            (group.start >= hoveredMarker.toStart && group.start <= hoveredMarker.toEnd)));

      const badgeColor = typeObj?.default_color ?? "#94a3b8";
      const badgeBg = colorWithAlpha(badgeColor, 0.18) ?? "rgba(148,163,184,0.15)";
      const badgeFontSize = Math.max(8, tokenFontSize * 0.6);
      const badgePaddingY = Math.max(1, tokenFontSize * 0.15);
      const badgePaddingX = Math.max(3, tokenFontSize * 0.35);
      const badgeRadius = Math.max(6, tokenFontSize * 0.6);
      const badgeMaxWidth = Math.max(80, tokenFontSize * 10);
      const badgeHeight = badgeFontSize + badgePaddingY * 2;
      const groupPadY = Math.max(6, tokenFontSize * 0.4);
      const groupPadX = Math.max(6, tokenFontSize * 0.35);
      const paddingTop = groupPadY + badgeHeight * 0.5 + 4;
      const groupSelected =
        selection.start !== null &&
        selection.end !== null &&
        !(group.end < Math.min(selection.start, selection.end) || group.start > Math.max(selection.start, selection.end));

      const groupNode = (
        <div
          key={`group-${groupIndex}-${group.tokens[0].id}`}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: Math.max(4, tokenFontSize * 0.25),
            padding: `${paddingTop}px ${groupPadX}px ${groupPadY}px ${groupPadX}px`,
            borderRadius: 14,
            border: showBorder || groupSelected ? "1px solid rgba(148,163,184,0.35)" : "1px solid transparent",
            background: isHoveredGroup
              ? "rgba(94,234,212,0.05)"
              : groupSelected
                ? "rgba(59,130,246,0.08)"
                : "transparent",
            boxShadow: isHoveredGroup
              ? "0 0 0 1px rgba(94,234,212,0.4)"
              : showBorder || groupSelected
                ? "0 0 0 1px rgba(148,163,184,0.25)"
                : "none",
            flex: "0 0 auto",
            minWidth,
            position: "relative",
          }}
          ref={(el) => {
            groupRefs.current[group.start] = el;
          }}
        >
          {typeObj && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: "50%",
                transform: "translate(-50%, -50%)",
                padding: `${badgePaddingY}px ${badgePaddingX}px`,
                borderRadius: badgeRadius,
                background: badgeColor,
                border: "1px solid rgba(0,0,0,0.25)",
                boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
                color: "#0b1120",
                fontSize: badgeFontSize,
                fontWeight: 700,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                maxWidth: badgeMaxWidth,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={getErrorTypeLabel(typeObj, locale)}
            >
              {getErrorTypeLabel(typeObj, locale)}
            </div>
          )}
          {/* Source marker intentionally removed */}
          <div
            style={{
              display: "flex",
              gap: Math.max(1, tokenGap),
              flexWrap: "wrap",
              justifyContent: "flex-start",
              alignItems: "center",
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (matchingMarker) {
                setHoveredMoveId(matchingMarker.id);
                setIsHoveringMove(true);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(dropTargetIndex ?? group.start);
              setIsHoveringMove(false);
              setHoveredMoveId(null);
              setDropTargetIndex(null);
            }}
            onMouseEnter={() => {
              if (matchingMarker) {
                setHoveredMoveId(matchingMarker.id);
                setIsHoveringMove(true);
              }
            }}
            onMouseLeave={() => {
              setIsHoveringMove(false);
              setDropTargetIndex(null);
            }}
          >
            {(hasHistory || matchingMarker) && (
              <button
                style={groupUndoButtonStyle}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRevert(group.start, group.end, matchingMarker?.id ?? null);
                  setSelection({ start: null, end: null });
                  setEditingRange(null);
                }}
                title={t("tokenEditor.undo")}
              >
                ↺
              </button>
            )}
            {group.tokens.map((tok, i) =>
              renderToken(tok, group.start + i, hasHistory || destSet.has(group.start + i))
            )}
          </div>
          {historyTokens.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", textAlign: "center" }}>
              {historyTokens.map((prev) => (
                <span
                  key={`${groupIndex}-prev-${prev.id}`}
                  style={{
                    ...chipStyles.previous,
                    fontSize: Math.max(8, tokenFontSize * 0.7),
                    padding: `${Math.max(0, tokenFontSize * 0.1)}px ${Math.max(1, tokenFontSize * 0.25)}px`,
                  }}
                >
                  {prev.text}
                </span>
              ))}
            </div>
          )}
        </div>
      );
      result.push(groupNode);
      if (lineBreakSet.has(visibleCount)) {
        result.push(
          <div
            key={`br-${visibleCount}`}
            style={{ width: "100%", height: tokenFontSize * 0.6, flexBasis: "100%" }}
          />
        );
      }
      result.push(renderGap(group.end + 1));
    });

    return result;
  };

  const toolbarButton = (label: string, onClick: () => void, disabled?: boolean, hotkey?: string, icon?: string) => (
    <button
      style={{
        padding: "8px 12px",
        borderRadius: 12,
        border: "1px solid rgba(148,163,184,0.4)",
        color: disabled ? "rgba(226,232,240,0.4)" : "#e2e8f0",
        background: "rgba(30,41,59,0.8)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 12,
      }}
      onClick={onClick}
      disabled={disabled}
      title={hotkey ? `${label} (${hotkey})` : label}
    >
      {icon && <span style={{ marginRight: 6 }}>{icon}</span>}
      {label}
    </button>
  );

  useEffect(() => {
    if (!hasLoadedTypeState) return;
    const ids = new Set(correctionCards.map((c) => c.id));
    setCorrectionTypeMap((prev) => {
      const next: Record<string, number | null> = {};
      correctionCards.forEach((card) => {
        next[card.id] = Object.prototype.hasOwnProperty.call(prev, card.id)
          ? prev[card.id]
          : activeErrorTypeId;
      });
      const unchanged =
        correctionCards.length === Object.keys(prev).length &&
        correctionCards.every((c) => prev[c.id] === next[c.id]);
      return unchanged ? prev : next;
    });
  }, [correctionCards, activeErrorTypeId, hasLoadedTypeState]);

  const correctionSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    const signature = correctionCards.map((c) => `${c.id}:${c.rangeStart}-${c.rangeEnd}`).join("|");
    if (signature !== correctionSignatureRef.current && correctionCards.length) {
      const last = correctionCards[correctionCards.length - 1];
      setSelection({ start: last.rangeStart, end: last.rangeEnd });
    }
    correctionSignatureRef.current = signature;
    prevCorrectionCountRef.current = correctionCards.length;
  }, [correctionCards]);

  const clearSelectionAfterTypePick = useCallback((cardId: string, typeId: number | null) => {
    updateCorrectionType(cardId, typeId);
    if (typeId !== null) {
      setSelection({ start: null, end: null });
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedTypeState) return;
    persistCorrectionTypes(textId, { activeErrorTypeId, assignments: correctionTypeMap });
  }, [textId, activeErrorTypeId, correctionTypeMap, hasLoadedTypeState]);

  const buildAnnotationsPayload = useCallback(
    () =>
      buildAnnotationsPayloadStandalone({
        initialText,
        tokens,
        originalTokens,
        correctionCards: correctionCards.map((c) => ({
          id: c.id,
          rangeStart: c.rangeStart,
          rangeEnd: c.rangeEnd,
          markerId: c.markerId,
        })),
        correctionTypeMap,
        moveMarkers: history.present.moveMarkers,
        annotationIdMap: annotationIdMap.current,
      }),
    [annotationIdMap, correctionCards, correctionTypeMap, history.present.moveMarkers, initialText, originalTokens, tokens]
  );

  const saveAnnotations = useCallback(async () => {
    const annotations = await buildAnnotationsPayload();
    const { skip, nextSignature } = shouldSkipSave(lastSavedSignatureRef.current, annotations);
    if (skip) {
      lastSavedSignatureRef.current = nextSignature;
      setHasUnsavedChanges(false);
      setSaveStatus("saved");
      return;
    }
    const response = await api.post(`/api/texts/${textId}/annotations`, {
      annotations,
      client_version: serverAnnotationVersion,
    });
    lastSavedSignatureRef.current = nextSignature;
    const items = Array.isArray(response.data) ? response.data : [];
    const maxVersion = items.reduce(
      (acc: number, ann: any) => Math.max(acc, ann?.version ?? serverAnnotationVersion),
      serverAnnotationVersion
    );
    setServerAnnotationVersion(maxVersion || serverAnnotationVersion + 1);
  }, [api, buildAnnotationsPayload, serverAnnotationVersion, textId]);

  // Autosave on token changes (debounced).
  useEffect(() => {
    if (process.env.NODE_ENV === "test") return;
    if (!history.present.tokens.length) return;
    if (!autosaveInitializedRef.current) {
      autosaveInitializedRef.current = true;
      return;
    }
    setHasUnsavedChanges(true);
    setSaveStatus("idle");
    let timer: number | null = window.setTimeout(async () => {
      setIsAutosaving(true);
      setSaveStatus("saving");
      setActionError(null);
      try {
        await saveAnnotations();
        setHasUnsavedChanges(false);
        setSaveStatus("saved");
        persistEditorState(textId, history.present);
      } catch (error: any) {
        setActionError(formatError(error));
        setSaveStatus("error");
      } finally {
        setIsAutosaving(false);
        timer = null;
      }
    }, 800);

    return () => {
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [history.present.tokens, saveAnnotations, t]);

  const lastEmittedStatus = useRef<SaveStatus | null>(null);
  useEffect(() => {
    const next: SaveStatus = { state: saveStatus, unsaved: hasUnsavedChanges };
    if (
      lastEmittedStatus.current?.state !== next.state ||
      lastEmittedStatus.current?.unsaved !== next.unsaved
    ) {
      lastEmittedStatus.current = next;
      onSaveStatusChange?.(next);
    }
  }, [saveStatus, hasUnsavedChanges, onSaveStatusChange, lastDecision]);

  useEffect(() => {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        sidebarOpen: isSidebarOpen,
        tokenGap,
        tokenFontSize,
        lastDecision,
        lastTextId: textId,
        viewTab,
        textPanelOpen: isTextPanelOpen,
        debugOpen: isDebugOpen,
      }),
    );
  }, [isSidebarOpen, tokenGap, tokenFontSize, lastDecision, textId, viewTab, isTextPanelOpen, isDebugOpen]);

  const handleSubmit = async () => {
    const unassigned = correctionCards.filter((card) => !correctionTypeMap[card.id]);
    if (unassigned.length) {
      setActionError("Please assign an error type to all corrections.");
      return;
    }
    setActionError(null);
    setActionMessage(null);
    setIsSubmitting(true);
    try {
      await saveAnnotations();
      await api.post(`/api/texts/${textId}/submit`);
      setActionMessage(t("common.submit"));
      setLastDecision("submit");
      const moved = await requestNextText();
      if (!moved) {
        navigate("/");
      }
    } catch (error: any) {
      setActionError(formatError(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Move markers visualization: arrows from old position to new position (using DOM refs for accuracy).
  const renderMoveOverlay = () => {
    if (!isHoveringMove || !tokenRowRef.current || !hoveredMoveId) return null;
    const containerRect = tokenRowRef.current.getBoundingClientRect();

    const rectForRange = (start: number, end: number) => {
      const groupEl = groupRefs.current[start];
      if (groupEl) {
        const r = groupEl.getBoundingClientRect();
        return {
          left: r.left - containerRect.left,
          top: r.top - containerRect.top,
          width: r.width,
          height: r.height,
        };
      }
      const range = getRangeRect(start, end);
      if (!range) return null;
      return {
        left: range.left,
        top: range.top,
        width: range.width,
        height: range.height,
      };
    };

    const arrows = history.present.moveMarkers
      .filter((marker) => marker.id === hoveredMoveId)
      .map((marker) => {
        const fromRect = rectForRange(marker.fromStart, marker.fromEnd);
        const toRect = rectForRange(marker.toStart, marker.toEnd);
        if (!fromRect || !toRect) return null;

        const x1 = fromRect.left + fromRect.width / 2;
        const y1 = fromRect.top + fromRect.height / 2;
        const x2 = toRect.left + toRect.width / 2;
        const y2 = toRect.top + toRect.height / 2;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        const offset = 12;
        const startX = x1 + ux * offset;
        const startY = y1 + uy * offset;
        const endX = x2 - ux * offset;
        const endY = y2 - uy * offset;
        const angle = (Math.atan2(endY - startY, endX - startX) * 180) / Math.PI;
        const visibleLength = Math.max(1, Math.hypot(endX - startX, endY - startY));

        return (
          <div
            key={marker.id}
            style={{
              position: "absolute",
              left: startX,
              top: startY,
              width: visibleLength,
              height: 2.5,
              transform: `rotate(${angle}deg)`,
              transformOrigin: "0 50%",
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "transparent",
                borderTop: "2px dashed #ef4444",
              }}
            />
            <div
              style={{
                position: "absolute",
                right: -8,
                top: -4,
                width: 0,
                height: 0,
                borderTop: "6px solid transparent",
                borderBottom: "6px solid transparent",
                borderLeft: "8px solid #ef4444",
              }}
            />
          </div>
        );
      })
      .filter(Boolean);

    return <>{arrows}</>;
  };

  const hasSelectionTokens = hasSelection;

  const handleOpenSettings = () => {
    try {
      persistEditorState(textId, history.present);
      localStorage.setItem("lastAnnotationPath", location.pathname);
    } catch {
      // ignore
    }
    navigate("/settings");
  };

  const errorTypeById = useMemo(() => {
    const map = new Map<number, ErrorType>();
    errorTypes.forEach((et) => map.set(et.id, et));
    return map;
  }, [errorTypes]);

  const resolveTypeLabel = useCallback(
    (typeId: number) => {
      const et = errorTypeById.get(typeId);
      if (!et) return null;
      return getErrorTypeLabel(et, locale);
    },
    [errorTypeById, locale]
  );

  const m2Preview = useMemo(
    () =>
      buildM2Preview({
        originalTokens,
        tokens,
        correctionCards,
        correctionTypeMap,
        correctionByIndex,
        resolveTypeLabel,
      }),
    [originalTokens, tokens, correctionCards, correctionTypeMap, correctionByIndex, resolveTypeLabel]
  );

  const applyTypeToSelection = useCallback(
    (typeId: number | null) => {
      if (!typeId) return;
      if (!selectedIndices.length) return;
      const affectedIds = new Set<string>();
      selectedIndices.forEach((idx) => {
        const cardId = correctionByIndex.get(idx);
        if (cardId) affectedIds.add(cardId);
      });
      if (!affectedIds.size) return;
      setCorrectionTypeMap((prev) => {
        const next = { ...prev };
        affectedIds.forEach((id) => {
          next[id] = typeId;
        });
        return next;
      });
    },
    [correctionByIndex, selectedIndices]
  );

  const hotkeyMap = useMemo(() => buildHotkeyMap(errorTypes), [errorTypes]);

  const eventToHotkeyStrings = useCallback((event: KeyboardEvent): { keySpec: string | null; codeSpec: string | null } => {
    const key = event.key?.toLowerCase();
    if (!key) return { keySpec: null, codeSpec: null };
    // ignore pure modifier presses
    if (["shift", "control", "ctrl", "alt", "meta"].includes(key)) return { keySpec: null, codeSpec: null };
    const baseSpec: HotkeySpec = {
      key,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    };
    const keySpec = normalizeHotkeySpec(baseSpec);
    const code = event.code;
    const codeSpec = code ? normalizeHotkeySpec({ ...baseSpec, code }, true) : null;
    return { keySpec, codeSpec };
  }, []);

  useEffect(() => {
    if (!hotkeyMap || Object.keys(hotkeyMap).length === 0) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || (target as HTMLElement).isContentEditable)
      ) {
        return;
      }
      const { keySpec, codeSpec } = eventToHotkeyStrings(event);
      if (!keySpec && !codeSpec) return;
      const typeId = (keySpec && hotkeyMap[keySpec]) || (codeSpec && hotkeyMap[codeSpec]);
      if (!typeId) return;
      event.preventDefault();
      setActiveErrorTypeId((prev) => (prev === typeId ? null : typeId));
      applyTypeToSelection(typeId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hotkeyMap, applyTypeToSelection, eventToHotkeyStrings]);

  const hasUnassignedCorrections = useMemo(
    () => correctionCards.some((card) => !correctionTypeMap[card.id]),
    [correctionCards, correctionTypeMap]
  );

  const debugData = useMemo(
    () => ({
      textId,
      viewTab,
      isTextPanelOpen,
      isDebugOpen,
      tokenGap,
      tokenFontSize,
      lineBreaks,
      activeErrorTypeId,
      correctionTypeMap,
      corrections: correctionCards.map((c) => ({
        id: c.id,
        range: [c.rangeStart, c.rangeEnd],
        original: c.original,
        updated: c.updated,
        error_type_id: correctionTypeMap[c.id] ?? null,
      })),
      tokens: history.present.tokens.map((t) => ({
        id: t.id,
        text: t.text,
        kind: t.kind,
        groupId: t.groupId,
        moveId: t.moveId,
        selected: t.selected,
        origin: t.origin,
        previous: t.previousTokens?.map((p) => p.text),
      })),
    }),
    [
      textId,
      viewTab,
      isTextPanelOpen,
      isDebugOpen,
      tokenGap,
      tokenFontSize,
      lineBreaks,
      activeErrorTypeId,
      correctionTypeMap,
      correctionCards,
      history.present.tokens,
    ]
  );

  const debugText = useMemo(() => JSON.stringify(debugData), [debugData]);

  const updateCorrectionType = (cardId: string, typeId: number | null) => {
    setCorrectionTypeMap((prev) => ({ ...prev, [cardId]: typeId }));
  };

  return (
    <div style={pageStyle}>
      <div style={twoColumnLayoutStyle}>
        <div style={mainColumnStyle}>
          {/* Token workspace */}
          <div style={workspaceStyle}>
            <div style={actionBarStyle}>
              {toolbarButton(t("tokenEditor.undo"), () => dispatch({ type: "UNDO" }), history.past.length === 0, "Ctrl+Z", "↺")}
              {toolbarButton(t("tokenEditor.redo"), () => dispatch({ type: "REDO" }), history.future.length === 0, "Ctrl+Y", "↻")}
              {toolbarButton(t("tokenEditor.delete"), () => {
                if (!hasSelectionTokens) return;
                const [s, e] = [selection.start!, selection.end!];
                dispatch({ type: "DELETE_SELECTED_TOKENS", range: [Math.min(s, e), Math.max(s, e)] });
                setSelection({ start: null, end: null });
              }, !hasSelectionTokens, "Del", "🗑️")}
              {toolbarButton(t("tokenEditor.insertBefore"), () => {
                if (!hasSelectionTokens) return;
                const [s, e] = [selection.start!, selection.end!];
                const start = Math.min(s, e);
                dispatch({ type: "INSERT_TOKEN_BEFORE_SELECTED", range: [start, Math.max(s, e)] });
                // Immediately enter edit mode on the newly inserted token.
                setSelection({ start, end: start });
                setEditingRange({ start, end: start });
                setEditText("");
                setActiveErrorTypeId((prev) => prev); // preserve current active error type for hotkeys
                setTimeout(() => {
                  if (editInputRef.current) {
                    editInputRef.current.focus();
                    if (typeof editInputRef.current.setSelectionRange === "function") {
                      editInputRef.current.setSelectionRange(0, 0);
                    }
                  }
                }, 10);
              }, !hasSelectionTokens, undefined, "➕")}
              {toolbarButton(t("tokenEditor.insertAfter"), () => {
                if (!hasSelectionTokens) return;
                const [s, e] = [selection.start!, selection.end!];
                const start = Math.min(s, e);
                const end = Math.max(s, e);
                dispatch({ type: "INSERT_TOKEN_AFTER_SELECTED", range: [start, end] });
                const newIndex = end + 1;
                setSelection({ start: newIndex, end: newIndex });
                setEditingRange({ start: newIndex, end: newIndex });
                setEditText("");
                setActiveErrorTypeId((prev) => prev); // preserve active type for hotkeys
                setTimeout(() => {
                  if (editInputRef.current) {
                    editInputRef.current.focus();
                    if (typeof editInputRef.current.setSelectionRange === "function") {
                      editInputRef.current.setSelectionRange(0, 0);
                    }
                  }
                }, 10);
              }, !hasSelectionTokens, "Insert", "➕")}
          {toolbarButton(t("tokenEditor.merge"), () => {
            if (!hasSelectionTokens || selectedIndices.length < 2) return;
            const [s, e] = [Math.min(selection.start!, selection.end!), Math.max(selection.start!, selection.end!)];
            dispatch({ type: "MERGE_RANGE", range: [s, e] });
            setSelection({ start: null, end: null });
          }, !hasSelectionTokens || selectedIndices.length < 2, undefined, "🔗")}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8, flexWrap: "wrap" }}>
            <span style={{ color: "#94a3b8", fontSize: 12 }}>{t("tokenEditor.spacing")}</span>
            <button
              style={miniNeutralButton}
              onClick={() => setTokenGap((g) => Math.max(0, g - 1))}
              title="Decrease spacing"
            >
              –
            </button>
            <button
              style={miniNeutralButton}
              onClick={() => {
                setTokenGap(0);
                setTokenFontSize(16);
              }}
              title="Reset spacing and size"
              aria-label="Reset spacing and size"
            >
              ↺
            </button>
            <button
              style={miniNeutralButton}
              onClick={() => setTokenGap((g) => Math.min(24, g + 1))}
              title="Increase spacing"
            >
              +
            </button>
            <span style={{ color: "#94a3b8", fontSize: 12, marginLeft: 10 }}>{t("tokenEditor.size")}</span>
            <button
              style={miniNeutralButton}
              onClick={() => setTokenFontSize((s) => Math.max(4, s - 2))}
              title="Smaller tokens"
            >
              –
            </button>
            <button
              style={miniNeutralButton}
              onClick={() => {
                setTokenFontSize(16);
              }}
              title="Reset size"
              aria-label="Reset size"
            >
              ↺
            </button>
            <button
              style={miniNeutralButton}
              onClick={() => setTokenFontSize((s) => Math.min(64, s + 2))}
              title="Larger tokens"
            >
              +
            </button>
          </div>
          <div style={actionGroupStyle}>
            <button
              style={{
                ...secondaryActionStyle,
                opacity: isSkipping ? 0.6 : 1,
                cursor: isSkipping ? "not-allowed" : "pointer",
              }}
              onClick={() => handleFlag("skip")}
              disabled={isSubmitting || isSkipping || isTrashing}
            >
              {isSkipping ? t("annotation.skipSubmitting") : t("annotation.skipText")}
            </button>
            <button
              style={{
                ...dangerActionStyle,
                opacity: isTrashing ? 0.6 : 1,
                cursor: isTrashing ? "not-allowed" : "pointer",
              }}
              onClick={() => handleFlag("trash")}
              disabled={isSubmitting || isSkipping || isTrashing}
            >
              {isTrashing ? t("annotation.trashSubmitting") : t("annotation.trashText")}
            </button>
            <div style={actionDividerStyle} />
            <button
              style={{
                ...primaryActionStyle,
                opacity: isSubmitting || hasUnassignedCorrections ? 0.6 : 1,
                cursor: isSubmitting || hasUnassignedCorrections ? "not-allowed" : "pointer",
              }}
              onClick={handleSubmit}
              disabled={isSubmitting || isSkipping || isTrashing || hasUnassignedCorrections}
              title={
                hasUnassignedCorrections
                  ? t("tokenEditor.assignTypesFirst") ?? "Assign an error type to all corrections"
                  : undefined
              }
            >
              {isSubmitting ? t("common.submitting") : t("common.submit")}
            </button>
          </div>
        </div>
        <div style={actionFeedbackStyle}>
          {(actionMessage || actionError) && (
            <span style={{ color: actionError ? "#fca5a5" : "#a7f3d0" }}>
              {typeof actionError === "string"
                ? actionError
                : actionError
                  ? t("common.error")
                  : actionMessage}
            </span>
          )}
        </div>

        <div
          style={{
            background: "rgba(15,23,42,0.75)",
            border: "1px solid rgba(148,163,184,0.5)",
            borderRadius: 12,
            overflow: "hidden",
            textAlign: "left",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 12px",
              borderBottom: "1px solid rgba(148,163,184,0.25)",
            }}
          >
            <div style={{ display: "flex", gap: 6 }}>
              <button
                style={{
                  ...miniNeutralButton,
                  background: viewTab === "original" ? "rgba(59,130,246,0.3)" : miniNeutralButton.background,
                  borderColor: viewTab === "original" ? "rgba(59,130,246,0.6)" : miniNeutralButton.border,
                }}
                onClick={() => {
                  if (viewTab === "original") {
                    setIsTextPanelOpen((v) => !v);
                  } else {
                    setViewTab("original");
                    setIsTextPanelOpen(true);
                  }
                }}
                aria-pressed={viewTab === "original"}
              >
                {t("tokenEditor.original") ?? "Original"}
              </button>
              <button
                style={{
                  ...miniNeutralButton,
                  background: viewTab === "corrected" ? "rgba(59,130,246,0.3)" : miniNeutralButton.background,
                  borderColor: viewTab === "corrected" ? "rgba(59,130,246,0.6)" : miniNeutralButton.border,
                }}
                onClick={() => {
                  if (viewTab === "corrected") {
                    setIsTextPanelOpen((v) => !v);
                  } else {
                    setViewTab("corrected");
                    setIsTextPanelOpen(true);
                  }
                }}
                aria-pressed={viewTab === "corrected"}
              >
                {t("tokenEditor.corrected") ?? "Corrected"}
              </button>
              <button
                style={{
                  ...miniNeutralButton,
                  background: viewTab === "m2" ? "rgba(59,130,246,0.3)" : miniNeutralButton.background,
                  borderColor: viewTab === "m2" ? "rgba(59,130,246,0.6)" : miniNeutralButton.border,
                }}
                onClick={() => {
                  if (viewTab === "m2") {
                    setIsTextPanelOpen((v) => !v);
                  } else {
                    setViewTab("m2");
                    setIsTextPanelOpen(true);
                  }
                }}
                aria-pressed={viewTab === "m2"}
              >
                {t("tokenEditor.m2") ?? "M2"}
              </button>
            </div>
            <button
              style={miniNeutralButton}
              onClick={() => setIsTextPanelOpen((v) => !v)}
              aria-expanded={isTextPanelOpen}
              data-testid="text-panel-toggle"
            >
              {isTextPanelOpen ? "−" : "+"}
            </button>
          </div>
          {isTextPanelOpen && (
            <div style={{ padding: "10px 12px" }} data-testid="text-view-panel">
              {viewTab === "m2" ? (
                <pre
                  style={{
                    margin: 0,
                    color: "#e2e8f0",
                    fontSize: 13,
                    wordBreak: "break-word",
                    whiteSpace: "pre-wrap",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  }}
                >
                  {m2Preview}
                </pre>
              ) : (
                <span
                  style={{
                    color: "#e2e8f0",
                    fontSize: 14,
                    wordBreak: "break-word",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {viewTab === "original"
                    ? buildTextFromTokensWithBreaks(originalTokens, lineBreaks)
                    : buildTextFromTokensWithBreaks(tokens, lineBreaks)}
                </span>
              )}
            </div>
          )}
        </div>

        <div
          data-testid="corrected-panel"
          style={{ ...tokenRowStyleBase, gap: Math.max(0, tokenGap) }}
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dropTargetIndex !== null) {
              handleDrop(dropTargetIndex);
            }
          }}
          ref={tokenRowRef}
        >
          {renderMoveOverlay()}
          {renderTokenGroups(tokens)}
          {/* Trailing drop zone */}
          <div
            style={{ width: 24, height: 24 }}
            onDragOver={(e) => {
              e.preventDefault();
              setDropTargetIndex(tokens.length);
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(dropTargetIndex ?? tokens.length);
            }}
          />
        </div>
        {/* Categories */}
        <div style={categoryPanelStyle}>
            <div style={{ ...rowLabelStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ visibility: "hidden" }}>{t("tokenEditor.categories")}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {isLoadingErrorTypes && <span style={{ color: "#94a3b8" }}>{t("common.loading")}</span>}
                <button
                  style={{
                    ...miniNeutralButton,
                    padding: "6px 8px",
                    minWidth: 32,
                    height: 32,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  onClick={handleOpenSettings}
                  title={t("common.settings")}
                >
                  ⚙
                </button>
              </div>
            </div>
            {errorTypesError && (
              <div style={{ color: "#fca5a5", fontSize: 12 }}>{errorTypesError}</div>
            )}
            {!isLoadingErrorTypes && !errorTypesError && groupedErrorTypes.length === 0 && (
              <div style={{ color: "#94a3b8", fontSize: 12 }}>
                {t("annotation.noErrorTypesTitle")}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {groupedErrorTypes.map((group, groupIdx) => (
                <div key={`${group.label}-${groupIdx}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {group.label && (
                    <div style={{ color: "#cbd5e1", fontWeight: 700, fontSize: 13, textAlign: "left" }}>
                      {group.label}
                    </div>
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {group.items.map((type, idx) => {
                      const primary = getErrorTypeLabel(type, locale);
                      const chipBg =
                        colorWithAlpha(type.default_color, 0.3) ??
                        categoryColors[(groupIdx + idx) % categoryColors.length];
                      const isActiveType = activeErrorTypeId === type.id;
                      const hotkey = (type.default_hotkey ?? "").trim();
                      return (
                        <div
                          key={type.id}
                          style={{
                            ...categoryChipStyle,
                            background: chipBg,
                            border: isActiveType ? "2px solid rgba(16,185,129,0.8)" : "1px solid rgba(148,163,184,0.35)",
                            boxShadow: isActiveType ? "0 0 0 2px rgba(16,185,129,0.25)" : "none",
                          }}
                          title={type.description ?? undefined}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            setActiveErrorTypeId((prev) => (prev === type.id ? null : type.id));
                            applyTypeToSelection(type.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setActiveErrorTypeId((prev) => (prev === type.id ? null : type.id));
                              applyTypeToSelection(type.id);
                            }
                          }}
                        >
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <div style={{ fontWeight: 700 }}>{primary}</div>
                            {hotkey && (
                              <span
                                style={{
                                  fontSize: 10,
                                  color: "#cbd5e1",
                                  border: "1px solid rgba(148,163,184,0.5)",
                                  borderRadius: 6,
                                  padding: "2px 6px",
                                  background: "rgba(15,23,42,0.6)",
                                  lineHeight: 1.2,
                                }}
                              >
                                {hotkey}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div
          style={{
            background: "rgba(15,23,42,0.6)",
            border: "1px solid rgba(148,163,184,0.4)",
            borderRadius: 10,
            overflow: "hidden",
            marginTop: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 12px",
              borderBottom: "1px solid rgba(148,163,184,0.25)",
            }}
          >
            <span style={{ color: "#94a3b8", fontSize: 12 }}>{t("tokenEditor.debugPanel") ?? "Debug"}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={miniNeutralButton}
                onClick={() => navigator.clipboard?.writeText(debugText)}
                title={t("common.copy") ?? "Copy"}
              >
                ⧉
              </button>
              <button
                style={miniNeutralButton}
                onClick={() => setIsDebugOpen((v) => !v)}
                aria-expanded={isDebugOpen}
              >
                {isDebugOpen ? "−" : "+"}
              </button>
            </div>
          </div>
          {isDebugOpen && (
            <pre
              style={{
                margin: 0,
                padding: "12px",
                maxHeight: 320,
                overflow: "auto",
                color: "#e2e8f0",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              }}
            >
              {debugText}
            </pre>
          )}
        </div>

        </div>

        {/* Corrections sidebar */}
        <div
          style={{
            ...sidebarStyle,
            width: isSidebarOpen ? 340 : 64,
            padding: isSidebarOpen ? 12 : 8,
            gap: 12,
            display: "flex",
            flexDirection: "column",
            alignSelf: "stretch",
            transition: "width 150ms ease, padding 150ms ease",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: isSidebarOpen ? "space-between" : "center",
              gap: 8,
            }}
          >
            {isSidebarOpen && (
              <div>
                <div style={{ color: "#e2e8f0", fontWeight: 700 }}>{t("tokenEditor.corrections")}</div>
                <div style={{ color: "#94a3b8", fontSize: 12 }}>
                  {correctionCards.length} {t("tokenEditor.items")}
                </div>
              </div>
            )}
            <button
              style={sidebarToggleButtonStyle}
              onClick={() => {
                setIsSidebarOpen((open) => !open);
                setHoveredCorrectionRange(null);
                setHoveredMoveId(null);
                setIsHoveringMove(false);
              }}
              title={isSidebarOpen ? t("tokenEditor.collapse") ?? "Collapse" : t("tokenEditor.expand") ?? "Expand"}
            >
              {isSidebarOpen ? "→" : "←"}
            </button>
          </div>
          {isSidebarOpen ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  style={{
                    ...miniOutlineButton,
                    opacity: correctionCards.length === 0 ? 0.5 : 1,
                    cursor: correctionCards.length === 0 ? "not-allowed" : "pointer",
                  }}
                  disabled={correctionCards.length === 0}
                  onClick={() => setShowClearConfirm(true)}
                >
                  {t("tokenEditor.clearAll")}
                </button>
              </div>
              {correctionCards.length === 0 && (
                <div style={{ color: "#94a3b8", fontSize: 12 }}>{t("tokenEditor.noCorrections")}</div>
              )}
              {correctionCards.map((card) => (
                <div
                  key={card.id}
                  style={correctionCardStyle}
                  onMouseEnter={() => {
                    setHoveredCorrectionRange([card.rangeStart, card.rangeEnd]);
                    if (card.markerId) {
                      setHoveredMoveId(card.markerId);
                      setIsHoveringMove(true);
                    }
                  }}
                  onMouseLeave={() => {
                    setHoveredCorrectionRange(null);
                    setHoveredMoveId(null);
                    setIsHoveringMove(false);
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", color: "#e2e8f0", fontWeight: 600 }}>
                    <span>{card.title}</span>
                    <span>{card.range}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <span style={{ color: "#94a3b8", fontSize: 12 }}>Type</span>
                    <select
                      style={{
                        padding: "6px 8px",
                        borderRadius: 10,
                        border: "1px solid rgba(148,163,184,0.4)",
                        background: "rgba(15,23,42,0.8)",
                        color: "#e2e8f0",
                        fontSize: 12,
                      }}
                      value={correctionTypeMap[card.id] ?? ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        updateCorrectionType(card.id, val ? Number(val) : null);
                      }}
                    >
                      <option value="">{t("tokenEditor.selectType") ?? "Select type"}</option>
                      {errorTypes.map((et) => (
                        <option key={et.id} value={et.id}>
                          {getErrorTypeLabel(et, locale)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
                    {t("tokenEditor.originalLabel")} {card.original}
                  </div>
                  <div style={{ color: "#c7d2fe", fontSize: 12, marginTop: 2 }}>
                    {t("tokenEditor.newLabel")} {card.updated || t("tokenEditor.empty")}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      style={miniOutlineButton}
                      onClick={() => {
                        handleRevert(card.rangeStart, card.rangeEnd, card.markerId);
                        setSelection({ start: null, end: null });
                        setHoveredCorrectionRange(null);
                        setHoveredMoveId(null);
                        setIsHoveringMove(false);
                      }}
                    >
                      {t("tokenEditor.removeAction")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: "#cbd5e1", fontSize: 12, textAlign: "center" }}>
              {t("tokenEditor.corrections")} ({correctionCards.length})
            </div>
          )}
        </div>
      </div>

      {showClearConfirm && (
        <div style={modalOverlayStyle}>
          <div style={modalContentStyle}>
            <p style={{ color: "#e2e8f0", marginBottom: 12 }}>{t("tokenEditor.clearConfirmMessage") ?? "Clear all corrections?"}</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={miniOutlineButton} onClick={() => setShowClearConfirm(false)}>
                {t("tokenEditor.clearCancel") ?? "Cancel"}
              </button>
              <button
                style={{ ...miniOutlineButton, borderColor: "rgba(239,68,68,0.6)", color: "#fecdd3" }}
                onClick={() => {
                  setShowClearConfirm(false);
                  dispatch({ type: "CLEAR_ALL" });
                  setSelection({ start: null, end: null });
                  setEditingRange(null);
                }}
              >
                {t("tokenEditor.clearConfirm") ?? "Clear"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingAction && (
        <div style={modalOverlayStyle}>
          <div style={modalContentStyle}>
            <h3 style={{ color: "#e2e8f0", marginBottom: 8 }}>
              {pendingAction === "skip" ? t("annotation.skipModalTitle") : t("annotation.trashModalTitle")}
            </h3>
            <p style={{ color: "#cbd5e1", fontSize: 13, marginBottom: 10 }}>
              {pendingAction === "skip" ? t("annotation.skipText") : t("annotation.trashText")}
            </p>
            <textarea
              style={{
                width: "100%",
                minHeight: 80,
                borderRadius: 10,
                border: "1px solid rgba(51,65,85,0.8)",
                background: "rgba(15,23,42,0.8)",
                color: "#e2e8f0",
                padding: 10,
                boxSizing: "border-box",
              }}
              placeholder={
                pendingAction === "skip"
                  ? t("annotation.skipPlaceholder") ?? "Reason (optional)"
                  : t("annotation.trashPlaceholder") ?? "Reason (optional)"
              }
              value={flagReason}
              onChange={(e) => setFlagReason(e.target.value)}
            />
            {flagError && (
              <div style={{ color: "#fca5a5", fontSize: 12, marginTop: 8 }}>
                {typeof flagError === "string" ? flagError : t("common.error")}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button style={miniOutlineButton} onClick={cancelFlag}>
                {t("tokenEditor.clearCancel") ?? "Cancel"}
              </button>
              <button
                style={
                  pendingAction === "trash"
                    ? { ...dangerActionStyle, minWidth: 110 }
                    : { ...secondaryActionStyle, minWidth: 110 }
                }
                onClick={confirmFlag}
                disabled={isSkipping || isTrashing}
              >
                {pendingAction === "skip"
                  ? isSkipping
                    ? t("annotation.skipSubmitting")
                    : t("annotation.skipConfirm")
                  : isTrashing
                    ? t("annotation.trashSubmitting")
                    : t("annotation.trashConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------
// Styles
// ---------------------------
const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#0b1120",
  color: "#e2e8f0",
  padding: 16,
  boxSizing: "border-box",
  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const twoColumnLayoutStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 16,
  flexWrap: "wrap",
};

const mainColumnStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  flex: 1,
  minWidth: 0,
};

const workspaceStyle: React.CSSProperties = {
  background: "rgba(15,23,42,0.9)",
  borderRadius: 14,
  padding: 16,
  border: "1px solid rgba(51,65,85,0.7)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  position: "relative",
};

const rowLabelStyle: React.CSSProperties = {
  color: "#cbd5e1",
  fontSize: 12,
  marginBottom: 4,
};

const tokenRowStyleBase: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  background: "rgba(15,23,42,0.6)",
  padding: 2,
  borderRadius: 12,
  border: "1px solid rgba(51,65,85,0.6)",
  position: "relative",
};

const actionBarStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
  padding: "8px 0",
};

const actionGroupStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginLeft: "auto",
};

const actionFeedbackStyle: React.CSSProperties = {
  minHeight: 18,
  marginTop: 6,
  fontSize: 12,
};

const actionDividerStyle: React.CSSProperties = {
  width: 1,
  height: 28,
  background: "rgba(148,163,184,0.35)",
};

const categoryPanelStyle: React.CSSProperties = {
  background: "rgba(15,23,42,0.9)",
  borderRadius: 14,
  padding: 16,
  border: "1px solid rgba(51,65,85,0.7)",
};

const categoryChipStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  color: "#e2e8f0",
  fontWeight: 600,
  minWidth: 0,
  width: "auto",
  textAlign: "left",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  lineHeight: 1.2,
  cursor: "pointer",
};

const categoryColors = [
  "rgba(120,53,15,0.35)",
  "rgba(17,94,89,0.45)",
  "rgba(37,99,235,0.35)",
  "rgba(76,29,149,0.35)",
  "rgba(30,64,175,0.35)",
  "rgba(153,27,27,0.35)",
];

const sidebarStyle: React.CSSProperties = {
  background: "rgba(15,23,42,0.9)",
  border: "1px solid rgba(51,65,85,0.6)",
  borderRadius: 14,
  padding: 12,
  minHeight: 200,
};

const miniOutlineButton: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid rgba(236,72,153,0.5)",
  color: "#f9a8d4",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
};

const miniNeutralButton: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid rgba(148,163,184,0.6)",
  color: "#e2e8f0",
  background: "rgba(15,23,42,0.6)",
  cursor: "pointer",
  fontSize: 12,
};

const primaryActionStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 10,
  border: "1px solid rgba(16,185,129,0.6)",
  background: "rgba(16,185,129,0.2)",
  color: "#a7f3d0",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 13,
};

const secondaryActionStyle: React.CSSProperties = {
  ...primaryActionStyle,
  border: "1px solid rgba(148,163,184,0.6)",
  background: "rgba(148,163,184,0.15)",
  color: "#e2e8f0",
};

const dangerActionStyle: React.CSSProperties = {
  ...primaryActionStyle,
  border: "1px solid rgba(248,113,113,0.6)",
  background: "rgba(248,113,113,0.15)",
  color: "#fecdd3",
};

const correctionCardStyle: React.CSSProperties = {
  borderRadius: 12,
  border: "1px solid rgba(51,65,85,0.6)",
  padding: 10,
  background: "rgba(15,23,42,0.7)",
  cursor: "pointer",
};

const sidebarToggleButtonStyle: React.CSSProperties = {
  ...miniOutlineButton,
  minWidth: 32,
  borderColor: "rgba(148,163,184,0.5)",
  color: "#e2e8f0",
};

const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 50,
};

const modalContentStyle: React.CSSProperties = {
  background: "rgba(15,23,42,0.95)",
  border: "1px solid rgba(51,65,85,0.8)",
  borderRadius: 14,
  padding: 16,
  maxWidth: 360,
  width: "100%",
};

const groupUndoButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: -10,
  right: -10,
  width: 20,
  height: 20,
  borderRadius: "50%",
  border: "1px solid rgba(148,163,184,0.5)",
  background: "rgba(15,23,42,0.8)",
  color: "#e2e8f0",
  fontSize: 12,
  cursor: "pointer",
};
