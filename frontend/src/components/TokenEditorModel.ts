import { AnnotationDetailPayload, AnnotationDraft, ErrorType, TokenFragmentPayload } from "../types";
import { createSpecialTokenMatchers, isSpecialTokenText } from "../utils/specialTokens";

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
  spaceBefore?: boolean;
  baseIndex?: number;
  previousTokens?: Token[];
  groupId?: string;
  origin?: "inserted";
  moveId?: string;
};

export type MoveMarker = {
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
  operations: Operation[];
};

// History state for undo/redo.
export type EditorHistoryState = {
  past: EditorPresentState[];
  present: EditorPresentState;
  future: EditorPresentState[];
};

export type OperationType = "replace" | "delete" | "insert" | "move" | "noop";

export type Operation = {
  id: string;
  type: OperationType;
  start: number;
  end: number;
  after: TokenFragmentPayload[];
  moveFrom?: number;
  moveTo?: number;
  moveLength?: number;
};

export type CorrectionCardLite = {
  id: string;
  rangeStart: number;
  rangeEnd: number;
};

// Reducer actions. Most UI-specific data (like selection range) is provided in payload.
type Action =
  | { type: "INIT_FROM_TEXT"; text: string }
  | { type: "INIT_FROM_STATE"; state: EditorPresentState }
  | { type: "DELETE_SELECTED_TOKENS"; range: [number, number]; anchorIndex?: number }
  | { type: "MOVE_SELECTED_TOKENS"; fromStart: number; fromEnd: number; toIndex: number }
  | { type: "INSERT_TOKEN_BEFORE_SELECTED"; range: [number, number] | null }
  | { type: "INSERT_TOKEN_AFTER_SELECTED"; range: [number, number] | null }
  | { type: "EDIT_SELECTED_RANGE_AS_TEXT"; range: [number, number]; newText: string }
  | { type: "MERGE_RANGE"; range: [number, number] }
  | { type: "MERGE_WITH_NEXT"; index: number }
  | { type: "CANCEL_INSERT_PLACEHOLDER"; range: [number, number] }
  | { type: "CLEAR_ALL" }
  | { type: "REVERT_MOVE"; moveId: string }
  | { type: "REVERT_CORRECTION"; rangeStart: number; rangeEnd: number }
  | { type: "UNDO" }
  | { type: "REDO" };

// ---------------------------
// Utilities
// ---------------------------
// Treat any non-letter/number/non-space as punctuation/symbol.
const punctOnly = /^[^\p{L}\p{N}\s]+$/u;
let idCounter = 0;
export const createId = () => `token-${idCounter++}`;

const buildTokenFromText = (
  text: string,
  hadSpace: boolean,
  isFirst: boolean,
  idOverride?: string
): Token => {
  const isSpecial = isSpecialTokenText(text);
  const isPunct = !isSpecial && punctOnly.test(text);
  return {
    id: idOverride ?? createId(),
    text,
    kind: isSpecial ? "special" : isPunct ? "punct" : "word",
    selected: false,
    spaceBefore: isSpecial ? undefined : isFirst ? false : hadSpace,
    origin: undefined,
  };
};

const getLeadingSpace = (tokens: Token[], index: number): boolean =>
  index === 0 ? false : tokens[index]?.spaceBefore !== false;

const buildSpanKey = (start: number, end: number): string => `${start}-${end}`;

const readExplicitSpace = (fragment: any): boolean | undefined => {
  if (typeof fragment?.space_before === "boolean") return fragment.space_before;
  if (typeof fragment?.spaceBefore === "boolean") return fragment.spaceBefore;
  return undefined;
};

const buildPlaceholderToken = (previousTokens: Token[], overrides: Partial<Token> = {}): Token => ({
  id: createId(),
  text: "⬚",
  kind: "empty",
  selected: false,
  previousTokens,
  origin: undefined,
  ...overrides,
});

export const buildTokenFragment = (tok: Token): TokenFragmentPayload => {
  const fragment: TokenFragmentPayload = {
    id: tok.id,
    text: tok.text,
    origin: tok.origin === "inserted" ? "inserted" : "base",
    source_id:
      tok.origin === "inserted"
        ? tok.previousTokens?.find((p) => p.kind !== "empty")?.id ?? null
        : tok.id,
  };
  if (typeof tok.spaceBefore === "boolean") {
    fragment.space_before = tok.spaceBefore;
  }
  return fragment;
};

export type HotkeySpec = {
  key: string;
  code?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
};

export const normalizeHotkeySpec = (spec: HotkeySpec, useCode = false) => {
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
  const specialMatchers = createSpecialTokenMatchers();
  const baseRegex = /(\p{L}|\p{N})+|[^\p{L}\p{N}\s]/uy;

  let idx = 0;
  while (idx < text.length) {
    let hadSpace = false;
    while (idx < text.length && /\s/.test(text[idx])) {
      hadSpace = true;
      idx += 1;
    }
    if (idx >= text.length) break;

    let matched = false;
    for (const m of specialMatchers) {
      m.regex.lastIndex = idx;
      const res = m.regex.exec(text);
      if (res && res.index === idx) {
        const raw = res[0];
        const value = raw.replace(/[.,;:!?]+$/, "");
        const advanceBy = value.length || raw.length;
        tokens.push(buildTokenFromText(value, hadSpace, tokens.length === 0, `base-${tokens.length}`));
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
      tokens.push(buildTokenFromText(value, hadSpace, tokens.length === 0, `base-${tokens.length}`));
      idx += value.length;
      continue;
    }

    // If nothing matched, advance to avoid infinite loop.
    idx += 1;
  }

  return tokens;
};

export const computeLineBreaksFromText = (text: string): number[] => {
  const breaks: number[] = [];
  if (!text) return breaks;
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

export const buildTokensFromSnapshot = (snapshot: string[], sourceText: string): Token[] => {
  const tokens: Token[] = [];
  let cursor = 0;
  snapshot.forEach((text, idx) => {
    let hasSpace = false;
    while (cursor < sourceText.length && /\s/.test(sourceText[cursor])) {
      hasSpace = true;
      cursor += 1;
    }
    const nextIndex = sourceText.indexOf(text, cursor);
    if (nextIndex > cursor) {
      hasSpace = hasSpace || /\s/.test(sourceText.slice(cursor, nextIndex));
      cursor = nextIndex;
    }
    tokens.push(buildTokenFromText(text, hasSpace, idx === 0, `base-${idx}`));
    if (nextIndex >= 0) {
      cursor += text.length;
    }
  });
  return tokens;
};

type HydrationResult = {
  present: EditorPresentState;
  typeMap: Record<string, number | null>;
  spanMap: Map<string, number>;
};

export const hydrateFromServerAnnotations = ({
  items,
  initialText,
  currentUserId,
}: {
  items: any[];
  initialText: string;
  currentUserId?: string | null;
}): HydrationResult | null => {
  if (!items?.length) return null;
  const snapshotTokens = items.find(
    (ann: any) => Array.isArray(ann?.payload?.text_tokens) && ann.payload.text_tokens.length
  )?.payload?.text_tokens as string[] | undefined;
  const baseTokens = snapshotTokens?.length
    ? buildTokensFromSnapshot(snapshotTokens, initialText)
    : tokenizeToTokens(initialText);
  const originalById = new Map<string, Token>();
  const originalIndexById = new Map<string, number>();
  baseTokens.forEach((tok, idx) => {
    if (tok.kind === "empty") return;
    originalById.set(tok.id, tok);
    originalIndexById.set(tok.id, idx);
  });
  let working = cloneTokens(baseTokens);
  const offsetDeltas: Array<{ start: number; delta: number }> = [];
  const moveTargetById = new Map<string, { start: number; end: number }>();
  const offsetAt = (index: number) =>
    offsetDeltas.reduce((acc, entry) => (entry.start <= index ? acc + entry.delta : acc), 0);
  const typeMap: Record<string, number | null> = {};
  const spanMap = new Map<string, number>();
  const readMoveTo = (ann: any) =>
    typeof ann?.payload?.move_to === "number"
      ? ann.payload.move_to
      : typeof ann?.payload?.moveTo === "number"
        ? ann.payload.moveTo
        : typeof ann?.start_token === "number"
          ? ann.start_token
          : 0;
  const readMoveFrom = (ann: any) =>
    typeof ann?.payload?.move_from === "number"
      ? ann.payload.move_from
      : typeof ann?.payload?.moveFrom === "number"
        ? ann.payload.moveFrom
        : typeof ann?.start_token === "number"
          ? ann.start_token
          : 0;
  const normalizeOperation = (ann: any) => {
    const payload = ann?.payload || {};
    const operation = payload.operation || (ann?.replacement ? "replace" : "noop");
    const beforeTokensPayload = Array.isArray(payload.before_tokens) ? payload.before_tokens : [];
    const afterTokensPayload = Array.isArray(payload.after_tokens) ? payload.after_tokens : [];
    const hasReplacement = Boolean(ann?.replacement && String(ann.replacement).length > 0);
    if (operation === "noop" && (afterTokensPayload.length > 0 || beforeTokensPayload.length > 0 || hasReplacement)) {
      return "replace";
    }
    return String(operation);
  };
  const ordered = [...items].sort((a, b) => {
    const opA = normalizeOperation(a);
    const opB = normalizeOperation(b);
    const priority = (op: string) => (op === "move" ? 0 : 1);
    const prioDiff = priority(opA) - priority(opB);
    if (prioDiff !== 0) return prioDiff;
    if (opA === "move" && opB === "move") {
      const moveToA = readMoveTo(a);
      const moveToB = readMoveTo(b);
      if (moveToA !== moveToB) return moveToA - moveToB;
      const moveFromA = readMoveFrom(a);
      const moveFromB = readMoveFrom(b);
      const dirA = moveFromA < moveToA ? -1 : moveFromA > moveToA ? 1 : 0;
      const dirB = moveFromB < moveToB ? -1 : moveFromB > moveToB ? 1 : 0;
      if (dirA !== dirB) return dirA - dirB;
      if (dirA === -1 && moveFromA !== moveFromB) return moveFromB - moveFromA;
      if (dirA === 1 && moveFromA !== moveFromB) return moveFromA - moveFromB;
      return (a?.id ?? 0) - (b?.id ?? 0);
    }
    const startA = a?.start_token ?? 0;
    const startB = b?.start_token ?? 0;
    if (startA !== startB) return startA - startB;
    const endA = a?.end_token ?? 0;
    const endB = b?.end_token ?? 0;
    if (endA !== endB) return endA - endB;
    return (a?.id ?? 0) - (b?.id ?? 0);
  });
  ordered.forEach((ann: any) => {
    const payload = ann?.payload || {};
    const operation = payload.operation || (ann?.replacement ? "replace" : "noop");
    const beforeTokensPayload = Array.isArray(payload.before_tokens) ? payload.before_tokens : [];
    const afterTokensPayload = Array.isArray(payload.after_tokens) ? payload.after_tokens : [];
    const hasReplacement = Boolean(ann?.replacement && String(ann.replacement).length > 0);
    const normalizedOperation =
      operation === "noop" &&
      (afterTokensPayload.length > 0 || beforeTokensPayload.length > 0 || hasReplacement)
        ? "replace"
        : operation;
    if (normalizedOperation === "noop") return;
    if (String(normalizedOperation) === "move") {
      const afterRaw = afterTokensPayload;
      const moveFrom =
        typeof payload.move_from === "number"
          ? payload.move_from
          : typeof payload.moveFrom === "number"
            ? payload.moveFrom
            : typeof ann?.start_token === "number"
              ? ann.start_token
              : 0;
      const moveTo =
        typeof payload.move_to === "number"
          ? payload.move_to
          : typeof payload.moveTo === "number"
            ? payload.moveTo
            : typeof ann?.start_token === "number"
              ? ann.start_token
              : 0;
      const hasOriginalIds = beforeTokensPayload.length > 0;
      let moveLen =
        typeof payload.move_len === "number"
          ? payload.move_len
          : afterRaw.length
            ? afterRaw.length
            : beforeTokensPayload.length
              ? beforeTokensPayload.length
              : 1;
      const matchedRange = findRangeForOriginalIds(working, beforeTokensPayload);
      let sourceStart = moveFrom + offsetAt(moveFrom);
      sourceStart = Math.max(0, Math.min(working.length, sourceStart));
      let sourceEnd = Math.max(sourceStart, Math.min(working.length - 1, sourceStart + moveLen - 1));
      if (matchedRange) {
        sourceStart = matchedRange.start;
        sourceEnd = matchedRange.end;
        moveLen = sourceEnd - sourceStart + 1;
      }
      const moveId = `move-${createId()}`;

      const rawMovedTokensFromPayload = afterRaw.length ? buildTokensFromFragments(afterRaw, "", undefined) : [];
      let useSourceSlice = hasOriginalIds || Boolean(matchedRange);
      if (!useSourceSlice && rawMovedTokensFromPayload.length) {
        const preferredIndex = Number.isFinite(sourceStart) ? sourceStart : null;
        const matchedIndex = findMatchingSliceIndex(working, rawMovedTokensFromPayload, preferredIndex);
        if (matchedIndex !== null) {
          sourceStart = matchedIndex;
          sourceEnd = matchedIndex + rawMovedTokensFromPayload.length - 1;
          moveLen = sourceEnd - sourceStart + 1;
          useSourceSlice = true;
        }
      }

      const mappedHistory = beforeTokensPayload
        .map((id: string) => originalById.get(id))
        .filter(Boolean)
        .map((tok) => ({ ...tok!, selected: false, previousTokens: undefined }));
      const historyTokens = mappedHistory.length
        ? mappedHistory
        : useSourceSlice
          ? unwindHistoryTokens(working.slice(sourceStart, sourceEnd + 1))
          : [];
      const placeholder = buildPlaceholderToken(historyTokens, {
        groupId: `move-src-${moveId}`,
        moveId,
        spaceBefore: working[sourceStart]?.spaceBefore ?? true,
      });

      const rawMovedTokens = rawMovedTokensFromPayload.length
        ? rawMovedTokensFromPayload
        : useSourceSlice
          ? cloneTokens(working.slice(sourceStart, sourceEnd + 1))
          : [];

      if (useSourceSlice) {
        working.splice(sourceStart, sourceEnd - sourceStart + 1);
      }
      working.splice(sourceStart, 0, placeholder);

      let insertionIndex = hasOriginalIds
        ? findInsertionIndexByOriginalIndex(working, originalIndexById, moveTo, moveTargetById, true)
        : findInsertionIndexForEmptyMove(working, originalIndexById, moveTo, moveTargetById, true);
      insertionIndex = Math.max(0, Math.min(working.length, insertionIndex));
      const leadingSpace = getLeadingSpace(working, insertionIndex);

      const movedTokens = rawMovedTokens.map((tok, idx) => ({
        ...tok,
        id: createId(),
        groupId: `move-dest-${moveId}`,
        moveId,
        spaceBefore: idx === 0 ? leadingSpace : tok.spaceBefore,
        previousTokens: tok.previousTokens?.length
          ? cloneTokens(tok.previousTokens)
          : historyTokens.length
            ? cloneTokens(historyTokens)
            : tok.previousTokens,
      }));

      working.splice(insertionIndex, 0, ...movedTokens);
      typeMap[moveId] = ann?.error_type_id ?? null;
      const spanStart = moveTo;
      const spanEnd = moveTo + Math.max(1, movedTokens.length) - 1;
      moveTargetById.set(moveId, { start: spanStart, end: spanEnd });
      if (currentUserId && ann?.author_id === currentUserId && ann?.id != null) {
        spanMap.set(buildSpanKey(spanStart, spanEnd), ann.id);
      }
      const deltaSource = 1 - moveLen;
      const deltaDest = movedTokens.length;
      if (hasOriginalIds) {
        offsetDeltas.push({ start: moveFrom, delta: deltaSource });
      }
      offsetDeltas.push({ start: moveTo, delta: deltaDest });
      return;
    }
    const startOriginal = typeof ann?.start_token === "number" ? ann.start_token : 0;
    const endOriginal = typeof ann?.end_token === "number" ? ann.end_token : startOriginal;
    const defaultTargetStart = Math.max(0, Math.min(working.length, startOriginal + offsetAt(startOriginal)));
    let targetStart = defaultTargetStart;
    if (normalizedOperation === "insert") {
      if (beforeTokensPayload.length === 0) {
        targetStart = findInsertionIndexByOriginalIndex(
          working,
          originalIndexById,
          startOriginal,
          moveTargetById,
          false,
          true
        );
      } else {
        const anchorRange = findPreferredRangeForOriginalIds(
          working,
          beforeTokensPayload,
          originalIndexById,
          moveTargetById,
          startOriginal - 1
        );
        if (anchorRange) {
          targetStart = Math.min(working.length, anchorRange.end + 1);
        } else if (moveTargetById.size) {
          const targetIndex = startOriginal - 1;
          const candidateMoveIds = new Set(
            Array.from(moveTargetById.entries())
              .filter(([, span]) => span.end === targetIndex)
              .map(([id]) => id)
          );
          if (candidateMoveIds.size) {
            let anchorIndex: number | null = null;
            working.forEach((tok, idx) => {
              if (tok.kind !== "empty" && tok.moveId && candidateMoveIds.has(tok.moveId)) {
                anchorIndex = idx;
              }
            });
            if (anchorIndex !== null) {
              targetStart = Math.min(working.length, anchorIndex + 1);
            }
          }
        }
      }
    }
    const leadingSpace = getLeadingSpace(working, targetStart);
    const removeCountFromSpan =
      normalizedOperation === "insert"
        ? 0
        : Math.max(0, Math.min(working.length - targetStart, Math.max(0, endOriginal - startOriginal + 1)));
    const beforeCount =
      normalizedOperation === "insert"
        ? 0
        : beforeTokensPayload.length
          ? Math.min(working.length - targetStart, beforeTokensPayload.length)
          : 0;
    const removeCount = beforeCount > 0 ? beforeCount : removeCountFromSpan;
    const mappedHistory = beforeTokensPayload
      .map((id: string) => originalById.get(id))
      .filter(Boolean)
      .map((tok) => ({ ...tok!, selected: false, previousTokens: undefined }));
    const previousRaw = cloneTokens(working.slice(targetStart, targetStart + removeCount));
    const fallbackHistory =
      !previousRaw.length && !mappedHistory.length && beforeTokensPayload.length
        ? (() => {
            const count = Math.min(beforeTokensPayload.length, baseTokens.length);
            if (!count) return [];
            const maxStart = Math.max(0, baseTokens.length - count);
            const startIndex = Math.min(Math.max(0, startOriginal), maxStart);
            return cloneTokens(baseTokens.slice(startIndex, startIndex + count)).map((tok) => ({
              ...tok,
              selected: false,
              previousTokens: undefined,
            }));
          })()
        : [];
    const previousBase = previousRaw.length ? previousRaw : mappedHistory.length ? mappedHistory : fallbackHistory;
    const previous =
      normalizedOperation === "insert" && previousBase.length === 0 ? [makeEmptyPlaceholder([])] : previousBase;
    const afterRaw = afterTokensPayload;
    const replacementText = ann?.replacement ? String(ann.replacement) : "";
    const groupId = createId();
    const cardType = ann?.error_type_id ?? null;

    const newTokens: Token[] = [];
    const builtTokens = buildTokensFromFragments(afterRaw, replacementText, leadingSpace);
    if (!builtTokens.length && (normalizedOperation === "delete" || normalizedOperation === "insert")) {
      newTokens.push(buildPlaceholderToken(previous, { groupId, spaceBefore: leadingSpace }));
    } else {
      builtTokens.forEach((tok) => {
        newTokens.push({
          ...tok,
          id: createId(),
          groupId,
          selected: false,
          previousTokens: cloneTokens(previous),
        });
      });
    }
    if (newTokens.length) {
      const firstFrag = Array.isArray(afterRaw) ? afterRaw[0] : null;
      const hasExplicitSpace = firstFrag && typeof firstFrag === "object" && readExplicitSpace(firstFrag) !== undefined;
      if (!hasExplicitSpace) {
        newTokens[0].spaceBefore = leadingSpace;
      }
    }
    const removal = removeCount;
    working.splice(targetStart, removal, ...newTokens);
    typeMap[groupId] = cardType;
    if (
      currentUserId &&
      ann?.author_id === currentUserId &&
      ann?.id != null &&
      typeof ann.start_token === "number" &&
      typeof ann.end_token === "number"
    ) {
      spanMap.set(buildSpanKey(ann.start_token, ann.end_token), ann.id);
    }
    const delta = newTokens.length - removal;
    offsetDeltas.push({ start: startOriginal, delta });
  });
  const present: EditorPresentState = {
    originalTokens: cloneTokens(baseTokens),
    tokens: working,
    operations: [],
  };
  return { present, typeMap, spanMap };
};

// When editing an existing correction, respect the literal text the annotator typed,
// splitting only on explicit whitespace they inserted (punctuation stays inline).
export const tokenizeEditedText = (text: string): Token[] => {
  const tokens: Token[] = [];
  if (!text) return tokens;
  const parts = text.split(/(\s+)/);
  let spaceBefore = false;
  parts.forEach((part) => {
    if (!part) return;
    if (/^\s+$/.test(part)) {
      spaceBefore = true;
      return;
    }
    tokens.push(buildTokenFromText(part, spaceBefore, tokens.length === 0));
    spaceBefore = false;
  });
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

export const cloneTokens = (items: Token[]) =>
  items.map((t) => ({
    ...t,
    previousTokens: t.previousTokens?.map((p) => ({ ...p })),
    origin: t.origin,
    moveId: t.moveId,
  }));

export const makeEmptyPlaceholder = (previousTokens: Token[]): Token =>
  buildPlaceholderToken(previousTokens);

// Unwind correction chains to the earliest known state (walk previousTokens until none).
export const unwindToOriginal = (tokens: Token[]): Token[] => {
  const result: Token[] = [];
  tokens.forEach((tok) => {
    if (tok.previousTokens && tok.previousTokens.length) {
      result.push(...unwindToOriginal(tok.previousTokens));
    } else {
      result.push({ ...tok, previousTokens: undefined, selected: false, moveId: undefined });
    }
  });
  return result;
};

const restoreHistoryTokens = (items: Token[]): Token[] =>
  unwindHistoryTokens(items).map((tok) => ({
    ...tok,
    selected: false,
    previousTokens: undefined,
    moveId: undefined,
    groupId: undefined,
  }));

// Remove ⬚ tokens that carry no history (pure placeholders).
export const dropRedundantEmpties = (tokens: Token[]): Token[] =>
  tokens.filter((tok) => !(tok.kind === "empty" && (!tok.previousTokens || tok.previousTokens.length === 0)));

// Remove duplicate earliest tokens (by text+kind) to prevent double restore.
export const dedupeTokens = (tokens: Token[]): Token[] => {
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

export const rangeToArray = (range: [number, number]) => {
  const [start, end] = range;
  const arr: number[] = [];
  for (let i = start; i <= end; i += 1) arr.push(i);
  return arr;
};

export const findGroupRangeForTokens = (tokens: Token[], idx: number): [number, number] => {
  if (!tokens.length || idx < 0 || idx >= tokens.length) return [idx, idx];
  const tok = tokens[idx];
  if (!tok?.groupId) return [idx, idx];
  let l = idx;
  let r = idx;
  while (l - 1 >= 0 && tokens[l - 1]?.groupId === tok.groupId) l -= 1;
  while (r + 1 < tokens.length && tokens[r + 1]?.groupId === tok.groupId) r += 1;
  return [l, r];
};

const expandRangeByGroupKey = (
  tokens: Token[],
  start: number,
  end: number,
  getKey: (tok: Token | undefined) => string | number | null | undefined
): [number, number] => {
  let rangeStart = start;
  let rangeEnd = end;
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (let i = rangeStart; i <= rangeEnd; i += 1) {
      const key = getKey(tokens[i]);
      if (key == null) continue;
      let l = i;
      let r = i;
      while (l - 1 >= 0 && getKey(tokens[l - 1]) === key) l -= 1;
      while (r + 1 < tokens.length && getKey(tokens[r + 1]) === key) r += 1;
      if (l < rangeStart || r > rangeEnd) {
        rangeStart = Math.min(rangeStart, l);
        rangeEnd = Math.max(rangeEnd, r);
        expanded = true;
        break;
      }
    }
  }
  return [rangeStart, rangeEnd];
};

export const deriveCorrectionCards = (tokens: Token[], moveMarkers: MoveMarker[]): CorrectionCardLite[] => {
  const visited = new Set<number>();
  const groupHistory = new Set<string>();
  tokens.forEach((tok) => {
    if (tok.groupId && tok.previousTokens?.length) {
      groupHistory.add(tok.groupId);
    }
  });
  const baseCards = tokens
    .map((tok, idx) => {
      if (visited.has(idx)) return null;
      if (tok.moveId) return null;
      if (!tok.previousTokens?.length && !(tok.groupId && groupHistory.has(tok.groupId))) return null;
      const [rangeStart, rangeEnd] = findGroupRangeForTokens(tokens, idx);
      for (let i = rangeStart; i <= rangeEnd; i += 1) visited.add(i);
      return {
        id: tok.groupId ?? tok.id,
        rangeStart,
        rangeEnd,
      };
    })
    .filter(Boolean) as CorrectionCardLite[];

  const moveCards = moveMarkers.map((marker) => ({
    id: marker.id,
    rangeStart: marker.toStart,
    rangeEnd: marker.toEnd,
  }));

  return [...baseCards, ...moveCards];
};

export const deriveCorrectionByIndex = (
  cards: CorrectionCardLite[],
  moveMarkers: MoveMarker[]
): Map<number, string> => {
  const map = new Map<number, string>();
  cards.forEach((card) => {
    for (let i = card.rangeStart; i <= card.rangeEnd; i += 1) {
      map.set(i, card.id);
    }
  });
  moveMarkers.forEach((marker) => {
    for (let i = marker.fromStart; i <= marker.fromEnd; i += 1) {
      map.set(i, marker.id);
    }
    for (let i = marker.toStart; i <= marker.toEnd; i += 1) {
      map.set(i, marker.id);
    }
  });
  return map;
};


// Detect the placeholder token we create for insertions (text empty + previous empty marker).
export const isInsertPlaceholder = (tokens: Token[]) =>
  tokens.length === 1 &&
  tokens[0].text === "" &&
  tokens[0].previousTokens?.length &&
  tokens[0].previousTokens.every((p) => p.kind === "empty");

// Build a merged token from a slice, omitting ⬚ tokens from text and history.
export const buildMergedToken = (slice: Token[]): Token | null => {
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

export const deriveMoveMarkers = (tokens: Token[]): MoveMarker[] => {
  const map = new Map<
    string,
    { fromStart?: number; fromEnd?: number; toStart?: number; toEnd?: number }
  >();
  tokens.forEach((tok, idx) => {
    if (!tok.moveId) return;
    const entry = map.get(tok.moveId) ?? {};
    if (tok.kind === "empty") {
      entry.fromStart = entry.fromStart ?? idx;
      entry.fromEnd = idx;
    } else {
      entry.toStart = entry.toStart === undefined ? idx : Math.min(entry.toStart, idx);
      entry.toEnd = entry.toEnd === undefined ? idx : Math.max(entry.toEnd, idx);
    }
    map.set(tok.moveId, entry);
  });
  const markers: MoveMarker[] = [];
  map.forEach((entry, id) => {
    if (entry.fromStart === undefined || entry.toStart === undefined || entry.toEnd === undefined) return;
    markers.push({
      id,
      fromStart: entry.fromStart,
      fromEnd: entry.fromEnd ?? entry.fromStart,
      toStart: entry.toStart,
      toEnd: entry.toEnd,
    });
  });
  return markers;
};

// Compare sequences by visible content (text + kind + spacing), ignoring leading-space differences.
const sameTokenSequence = (existing: Token[], nextRaw: Token[]) => {
  if (existing.length !== nextRaw.length) return false;
  for (let i = 0; i < existing.length; i += 1) {
    const existingSpace = existing[i].spaceBefore ?? false;
    const nextSpace = nextRaw[i].spaceBefore ?? false;
    if (
      existing[i].text !== nextRaw[i].text ||
      existing[i].kind !== nextRaw[i].kind ||
      (i > 0 && existingSpace !== nextSpace)
    ) {
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
  present: { originalTokens: [], tokens: [], operations: [] },
  future: [],
});

const createOperationId = () => `op-${idCounter++}`;

const buildHistoryTokensForSpan = (originalTokens: Token[], start: number, end: number): Token[] => {
  if (start < 0 || end < start || start >= originalTokens.length) return [];
  return cloneTokens(originalTokens.slice(start, end + 1)).map((tok) => ({
    ...tok,
    selected: false,
    previousTokens: undefined,
    groupId: undefined,
    moveId: undefined,
    baseIndex: tok.baseIndex,
  }));
};

const unwindHistoryTokens = (items: Token[]): Token[] =>
  dedupeTokens(unwindToOriginal(cloneTokens(items))).filter((tok) => tok.kind !== "empty");

const getOriginalSpanForToken = (
  tok: Token,
  originalIndexById: Map<string, number>,
  moveTargetById?: Map<string, { start: number; end: number }>,
  skipMoveDest = false,
  skipInserted = false
): { min: number; max: number } | null => {
  if (skipInserted && tok.origin === "inserted") return null;
  if (tok.moveId && skipMoveDest && tok.kind !== "empty") return null;
  if (tok.moveId && tok.kind !== "empty" && moveTargetById?.has(tok.moveId)) {
    const target = moveTargetById.get(tok.moveId)!;
    return { min: target.start, max: target.end };
  }
  const indices: number[] = [];
  const direct = originalIndexById.get(tok.id);
  if (direct !== undefined) indices.push(direct);
    if (tok.previousTokens?.length) {
      const originals = unwindToOriginal(tok.previousTokens);
      originals.forEach((prev) => {
        const idx = originalIndexById.get(prev.id);
        if (idx !== undefined) indices.push(idx);
      });
  }
  if (!indices.length) return null;
  return { min: Math.min(...indices), max: Math.max(...indices) };
};

const findInsertionIndexFromTokens = (
  tokens: Token[],
  originalIndexById: Map<string, number>,
  rangeStart: number,
  rangeEnd: number,
  moveTargetById?: Map<string, { start: number; end: number }>,
  skipMoveDest = false,
  skipInserted = false
): number => {
  for (let i = rangeStart - 1; i >= 0; i -= 1) {
    const span = getOriginalSpanForToken(tokens[i], originalIndexById, moveTargetById, skipMoveDest, skipInserted);
    if (span) return span.max + 1;
  }
  for (let i = rangeEnd + 1; i < tokens.length; i += 1) {
    const span = getOriginalSpanForToken(tokens[i], originalIndexById, moveTargetById, skipMoveDest, skipInserted);
    if (span) return span.min;
  }
  return 0;
};

const findInsertionIndexByOriginalIndex = (
  tokens: Token[],
  originalIndexById: Map<string, number>,
  targetIndex: number,
  moveTargetById?: Map<string, { start: number; end: number }>,
  skipMoveDest = false,
  skipInserted = false
): number => {
  for (let i = 0; i < tokens.length; i += 1) {
    const span = getOriginalSpanForToken(tokens[i], originalIndexById, moveTargetById, skipMoveDest, skipInserted);
    if (!span) continue;
    if (span.min >= targetIndex) return i;
  }
  return tokens.length;
};

const findInsertionIndexForEmptyMove = (
  tokens: Token[],
  originalIndexById: Map<string, number>,
  targetIndex: number,
  moveTargetById?: Map<string, { start: number; end: number }>,
  skipMoveDest = false,
  skipInserted = false
): number => {
  let insertionIndex = findInsertionIndexByOriginalIndex(
    tokens,
    originalIndexById,
    targetIndex,
    moveTargetById,
    skipMoveDest,
    skipInserted
  );
  while (insertionIndex - 1 >= 0) {
    const span = getOriginalSpanForToken(
      tokens[insertionIndex - 1],
      originalIndexById,
      moveTargetById,
      skipMoveDest,
      skipInserted
    );
    if (span) break;
    insertionIndex -= 1;
  }
  return insertionIndex;
};

const findRangeForOriginalIds = (
  tokens: Token[],
  beforeIds: string[],
  options: { ignoreEmpty?: boolean } = {}
): { start: number; end: number } | null => {
  if (!beforeIds.length) return null;
  const idSet = new Set(beforeIds);
  const indices: number[] = [];
  tokens.forEach((tok, idx) => {
    if (options.ignoreEmpty && tok.kind === "empty") return;
    if (tok.kind === "empty") return;
    if (idSet.has(tok.id)) {
      indices.push(idx);
      return;
    }
    if (tok.previousTokens?.length) {
      const originals = unwindToOriginal(tok.previousTokens);
      if (originals.some((prev) => idSet.has(prev.id))) {
        indices.push(idx);
      }
    }
  });
  if (!indices.length) return null;
  return { start: Math.min(...indices), end: Math.max(...indices) };
};

const spanDistance = (target: number, span: { min: number; max: number }) => {
  if (target < span.min) return span.min - target;
  if (target > span.max) return target - span.max;
  return 0;
};

const spansOverlap = (a: { min: number; max: number }, b: { min: number; max: number }) =>
  a.min <= b.max && b.min <= a.max;

const findPreferredRangeForOriginalIds = (
  tokens: Token[],
  beforeIds: string[],
  originalIndexById: Map<string, number>,
  moveTargetById: Map<string, { start: number; end: number }>,
  targetIndex: number
): { start: number; end: number } | null => {
  if (!beforeIds.length) return null;
  const idSet = new Set(beforeIds);
  const candidates: Array<{ idx: number; span: { min: number; max: number } }> = [];

  tokens.forEach((tok, idx) => {
    if (tok.kind === "empty" && (!tok.previousTokens || tok.previousTokens.length === 0)) return;
    const direct = idSet.has(tok.id);
    const historyMatch =
      tok.previousTokens?.length &&
      unwindToOriginal(tok.previousTokens).some((prev) => idSet.has(prev.id));
    if (!direct && !historyMatch) return;
    const span = getOriginalSpanForToken(tok, originalIndexById, moveTargetById);
    if (!span) return;
    candidates.push({ idx, span });
  });

  if (!candidates.length) return null;
  const anchorIndex = Math.max(0, targetIndex);
  let best = candidates[0];
  let bestDistance = spanDistance(anchorIndex, best.span);
  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const distance = spanDistance(anchorIndex, candidate.span);
    if (distance < bestDistance || (distance === bestDistance && candidate.idx > best.idx)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  let rangeStart = best.idx;
  let rangeEnd = best.idx;
  candidates.forEach((candidate) => {
    if (spansOverlap(candidate.span, best.span)) {
      rangeStart = Math.min(rangeStart, candidate.idx);
      rangeEnd = Math.max(rangeEnd, candidate.idx);
    }
  });
  return { start: rangeStart, end: rangeEnd };
};

const findMatchingSliceIndex = (tokens: Token[], pattern: Token[], preferredIndex: number | null): number | null => {
  if (!pattern.length) return null;
  if (typeof preferredIndex !== "number") return null;
  if (preferredIndex < 0 || preferredIndex + pattern.length > tokens.length) return null;
  for (let j = 0; j < pattern.length; j += 1) {
    const tok = tokens[preferredIndex + j];
    const pat = pattern[j];
    if (tok.kind === "empty" || tok.moveId) return null;
    if (tok.text !== pat.text || tok.kind !== pat.kind) return null;
    if (pat.origin === "inserted" && tok.origin !== "inserted") return null;
  }
  return preferredIndex;
};

export const buildTokensFromFragments = (
  fragments: TokenFragmentPayload[],
  fallbackText: string,
  defaultFirstSpace?: boolean,
  originOverride?: "inserted"
): Token[] => {
  const built: Token[] = [];
  const hasFragments = fragments.length > 0;
  const baseFragments = hasFragments ? fragments : fallbackText ? [{ text: fallbackText, origin: "base" }] : [];
  baseFragments.forEach((frag, fragIndex) => {
    const text = typeof frag?.text === "string" ? frag.text : "";
    if (!text) return;
    const origin = originOverride ?? (frag?.origin === "inserted" ? "inserted" : undefined);
    const explicitSpace = readExplicitSpace(frag);
    const baseTokens = tokenizeEditedText(text);
    baseTokens.forEach((tok, idx) => {
      let spaceBefore = tok.spaceBefore;
      if (idx === 0) {
        if (explicitSpace !== undefined) {
          spaceBefore = explicitSpace;
        } else if (fragIndex > 0) {
          spaceBefore = tok.kind === "punct" ? false : true;
        } else if (defaultFirstSpace !== undefined) {
          spaceBefore = defaultFirstSpace;
        }
      }
      if (idx === 0 && fragIndex > 0 && spaceBefore === false && tok.kind !== "punct") {
        spaceBefore = true;
      }
      built.push({
        ...tok,
        id: createId(),
        origin,
        spaceBefore,
      });
    });
  });
  return built;
};

const applyOperations = (originalTokens: Token[], operations: Operation[]): Token[] => {
  const baseTokens = cloneTokens(originalTokens).map((tok, idx) => ({
    ...tok,
    selected: false,
    previousTokens: undefined,
    groupId: undefined,
    baseIndex: idx,
  }));
  let working = baseTokens;
  let offset = 0;
  const ordered = [...operations].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id)
  );

  ordered.forEach((op) => {
    if (op.type === "noop") return;
    if (op.type === "move") return;

    const startOriginal = op.start;
    const endOriginal = op.end;
    const targetStart = Math.max(0, Math.min(working.length, startOriginal + offset));
    const leadingSpace = getLeadingSpace(working, targetStart);
    const removeCount = op.type === "insert" ? 0 : Math.max(0, endOriginal - startOriginal + 1);
    const historyTokens = op.type === "insert" ? [] : buildHistoryTokensForSpan(originalTokens, op.start, op.end);
    const history = op.type === "insert" ? [makeEmptyPlaceholder([])] : historyTokens;
    const builtTokens = buildTokensFromFragments(op.after, "", leadingSpace, op.type === "insert" ? "inserted" : undefined);
    let newTokens: Token[] = [];
    if (!builtTokens.length && op.type === "insert") {
      newTokens = [
        {
          id: `${op.id}-ph`,
          text: "",
          kind: "word",
          selected: false,
          origin: "inserted",
          previousTokens: cloneTokens(history),
          groupId: op.id,
          spaceBefore: leadingSpace,
        },
      ];
    } else if (!builtTokens.length && op.type === "delete") {
      newTokens = [
        buildPlaceholderToken(history, { id: `${op.id}-ph`, groupId: op.id, spaceBefore: leadingSpace }),
      ];
    } else {
      newTokens = builtTokens.map((tok, idx) => ({
        ...tok,
        id: `${op.id}-${idx}`,
        groupId: op.id,
        selected: false,
        previousTokens: cloneTokens(history),
      }));
    }
    if (newTokens.length) {
      const firstFrag = op.after[0];
      const hasExplicitSpace = readExplicitSpace(firstFrag) !== undefined;
      if (!hasExplicitSpace) {
        newTokens[0].spaceBefore = leadingSpace;
      }
    }
    working = [...working.slice(0, targetStart), ...newTokens, ...working.slice(targetStart + removeCount)];
    offset += newTokens.length - removeCount;
  });

  return working;
};


export const deriveOperationsFromTokens = (originalTokens: Token[], tokens: Token[]): Operation[] => {
  const originalIndexById = new Map<string, number>();
  originalTokens.forEach((tok, idx) => {
    if (tok.kind !== "empty") originalIndexById.set(tok.id, idx);
  });

  const findInsertionIndex = (rangeStart: number, rangeEnd: number) =>
    findInsertionIndexFromTokens(tokens, originalIndexById, rangeStart, rangeEnd, moveTargetById);

  const tokensToFragments = (items: Token[]): TokenFragmentPayload[] =>
    items
      .filter((tok) => tok.kind !== "empty" && tok.text !== "")
      .map((tok) => {
        const fragment = buildTokenFragment(tok);
        delete (fragment as Partial<TokenFragmentPayload>).id;
        delete (fragment as Partial<TokenFragmentPayload>).source_id;
        return fragment;
      });

  const operations: Operation[] = [];

  const visited = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.moveId) continue;
    const opId = tok.groupId ?? tok.id;
    if (visited.has(opId)) continue;
    const [rangeStart, rangeEnd] = tok.groupId ? findGroupRangeForTokens(tokens, i) : [i, i];
    const groupTokens = tokens.slice(rangeStart, rangeEnd + 1);
    const hasHistory = groupTokens.some((t) => t.previousTokens && t.previousTokens.length);
    if (!hasHistory) {
      visited.add(opId);
      continue;
    }
    const historyTokens: Token[] = [];
    groupTokens.forEach((t) => {
      if (t.previousTokens?.length) {
        historyTokens.push(...cloneTokens(t.previousTokens));
      }
    });
    const baseHistory = unwindHistoryTokens(historyTokens);
    const baseIndices = baseHistory
      .map((t) => originalIndexById.get(t.id))
      .filter((idx): idx is number => idx !== undefined);
    const after = tokensToFragments(groupTokens);
    let type: OperationType;
    if (!baseIndices.length) {
      type = "insert";
    } else if (after.length === 0) {
      type = "delete";
    } else {
      type = "replace";
    }
    const spanStart = baseIndices.length
      ? Math.min(...baseIndices)
      : findInsertionIndexFromTokens(tokens, originalIndexById, rangeStart, rangeEnd);
    const spanEnd = baseIndices.length ? Math.max(...baseIndices) : spanStart;
    operations.push({
      id: opId,
      type,
      start: spanStart,
      end: spanEnd,
      after,
    });
    visited.add(opId);
  }

  return operations.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
};

const buildPresentFromOperations = (originalTokens: Token[], operations: Operation[]): EditorPresentState => {
  const tokens = applyOperations(originalTokens, operations);
  return {
    originalTokens: cloneTokens(originalTokens),
    tokens,
    operations: [...operations],
  };
};

const buildPresentWithDerivedOperations = (present: EditorPresentState): EditorPresentState => ({
  originalTokens: cloneTokens(present.originalTokens),
  tokens: cloneTokens(present.tokens),
  operations: deriveOperationsFromTokens(present.originalTokens, present.tokens),
});

const normalizePresentState = (present: EditorPresentState): EditorPresentState => {
  const moveMarkers = deriveMoveMarkers(present.tokens);
  let operations = deriveOperationsFromTokens(present.originalTokens, present.tokens);
  if (!operations.length) {
    const originalVisible = present.originalTokens.filter((t) => t.kind !== "empty");
    const currentVisible = present.tokens.filter((t) => t.kind !== "empty");
    if (!sameTokenSequence(originalVisible, currentVisible) && currentVisible.length) {
      const after = currentVisible.map((tok) => ({
        text: tok.text,
        origin: tok.origin === "inserted" ? "inserted" : "base",
        space_before: tok.spaceBefore,
      }));
      const end = originalVisible.length ? originalVisible.length - 1 : 0;
      operations = [
        {
          id: createOperationId(),
          type: originalVisible.length ? "replace" : "insert",
          start: 0,
          end,
          after,
        },
      ];
    }
  }
  if (moveMarkers.length) {
    return { ...present, operations };
  }
  return buildPresentFromOperations(present.originalTokens, operations);
};

const normalizeHistoryState = (state: EditorHistoryState): EditorHistoryState => ({
  past: state.past.map(normalizePresentState),
  present: normalizePresentState(state.present),
  future: state.future.map(normalizePresentState),
});

// ---------------------------
// Reducer
// ---------------------------
const tokenReducer = (state: EditorHistoryState, action: Action): EditorHistoryState => {
  switch (action.type) {
    case "INIT_FROM_TEXT": {
      const original = tokenizeToTokens(action.text);
      const present: EditorPresentState = {
        originalTokens: cloneTokens(original),
        tokens: cloneTokens(original),
      };
      return { past: [], present, future: [] };
    }
    case "INIT_FROM_STATE": {
      const present: EditorPresentState = {
        originalTokens: cloneTokens(action.state.originalTokens),
        tokens: cloneTokens(action.state.tokens),
      };
      return { past: [], present, future: [] };
    }
    case "DELETE_SELECTED_TOKENS": {
      let [start, end] = action.range;
      if (start < 0 || end < start || start >= state.present.tokens.length) return state;
      const tokens = cloneTokens(state.present.tokens);
      const selectionHasHistoryPlaceholder = tokens
        .slice(start, end + 1)
        .some((tok) => tok.kind === "empty" && tok.previousTokens && tok.previousTokens.length);
      // If selection already includes a deleted placeholder, include its adjacent history placeholders too.
      if (selectionHasHistoryPlaceholder) {
        while (
          start > 0 &&
          tokens[start - 1]?.kind === "empty" &&
          tokens[start - 1]?.previousTokens &&
          tokens[start - 1]!.previousTokens!.length
        ) {
          start -= 1;
        }
        while (
          end + 1 < tokens.length &&
          tokens[end + 1]?.kind === "empty" &&
          tokens[end + 1]?.previousTokens &&
          tokens[end + 1]!.previousTokens!.length
        ) {
          end += 1;
        }
      }
      // Expand selection to include the whole inserted group if selection intersects it.
      [start, end] = expandRangeByGroupKey(tokens, start, end, (tok) =>
        tok?.origin === "inserted" ? (tok.groupId ?? "__inserted__") : null
      );
      // Expand selection to include entire correction group (e.g., split result) sharing the same groupId that carries history.
      [start, end] = expandRangeByGroupKey(tokens, start, end, (tok) => tok?.groupId ?? null);
      const leadingSpace = getLeadingSpace(tokens, start);
      const removed = tokens.slice(start, end + 1);
      const moveId = removed.find((tok) => tok.moveId && tok.kind !== "empty")?.moveId;
      const isMoveDestOnly =
        moveId &&
        removed.length > 0 &&
        removed.every((tok) => tok.kind !== "empty" && tok.moveId === moveId);
      if (isMoveDestOnly) {
        tokens.splice(start, removed.length);
        const placeholderIndex = tokens.findIndex((tok) => tok.moveId === moveId && tok.kind === "empty");
        if (placeholderIndex >= 0) {
          const placeholder = tokens[placeholderIndex];
          const history = placeholder.previousTokens?.length
            ? restoreHistoryTokens(placeholder.previousTokens)
            : [];
          if (history.length) {
            tokens.splice(
              placeholderIndex,
              1,
              buildPlaceholderToken(history, {
                spaceBefore:
                  typeof placeholder.spaceBefore === "boolean"
                    ? placeholder.spaceBefore
                    : getLeadingSpace(tokens, placeholderIndex),
              })
            );
          } else {
            tokens.splice(placeholderIndex, 1);
          }
        }
        const cleanedTokens = dropRedundantEmpties(tokens);
        const next: EditorPresentState = { ...state.present, tokens: cleanedTokens };
        return pushPresent(state, next);
      }
      const anchorIndex =
        typeof action.anchorIndex === "number" && action.anchorIndex >= start && action.anchorIndex <= end
          ? action.anchorIndex - start
          : null;
      const isDeletionPlaceholder = (tok: Token) =>
        tok.kind === "empty" && tok.previousTokens && tok.previousTokens.length > 0;
      if (removed.length > 1 && removed.every(isDeletionPlaceholder) && anchorIndex !== null) {
        const replacement: Token[] = [];
        removed.forEach((tok, idx) => {
          if (idx === anchorIndex) {
            const restore = restoreHistoryTokens(tok.previousTokens ?? []);
            if (restore.length) {
              replacement.push(...restore);
            } else {
              replacement.push(buildPlaceholderToken([], { selected: false }));
            }
          } else {
            replacement.push({ ...tok, selected: false });
          }
        });
        tokens.splice(start, removed.length, ...replacement);
        const cleanedTokens = dropRedundantEmpties(tokens);
        const next: EditorPresentState = { ...state.present, tokens: cleanedTokens };
        return pushPresent(state, next);
      }
      // If user deletes only inserted tokens, treat it as reverting that insertion (no placeholder).
      const allInserted = removed.every((t) => t.origin === "inserted");
      if (allInserted) {
        tokens.splice(start, removed.length);
        const next: EditorPresentState = { ...state.present, tokens };
        return pushPresent(state, next);
      }
      // If selection contains a correction cluster (e.g., split) with history, restore the original tokens instead of adding ⬚.
      const anchorWithHistory = removed.find((t) => t.previousTokens && t.previousTokens.length);
      if (anchorWithHistory) {
        const replacement = restoreHistoryTokens(anchorWithHistory.previousTokens ?? []);
        if (!replacement.length) {
          replacement.push(buildPlaceholderToken([], { selected: false }));
        }
        tokens.splice(start, removed.length, ...replacement);
        const cleanedTokens = dropRedundantEmpties(tokens);
        const next: EditorPresentState = { ...state.present, tokens: cleanedTokens };
        return pushPresent(state, next);
      }
      // If a single empty with no history, just remove it.
      if (removed.length === 1 && removed[0].kind === "empty" && !removed[0].previousTokens?.length) {
        tokens.splice(start, removed.length);
        const next: EditorPresentState = { ...state.present, tokens };
        return pushPresent(state, next);
      }
      const previousTokens = unwindHistoryTokens(
        removed.flatMap((t) => unwindToOriginal([t])).map((tok) => ({ ...tok, selected: false }))
      );
      if (!previousTokens.length) {
        previousTokens.push(makeEmptyPlaceholder([]));
      }
      const placeholder = buildPlaceholderToken(previousTokens, { spaceBefore: leadingSpace });
      tokens.splice(start, removed.length, placeholder);
      const next: EditorPresentState = { ...state.present, tokens };
      return pushPresent(state, next);
    }
    case "MOVE_SELECTED_TOKENS": {
      let { fromStart, fromEnd, toIndex } = action;
      if (fromStart < 0 || fromEnd < fromStart || fromStart >= state.present.tokens.length) return state;
      const tokens = cloneTokens(state.present.tokens);
      if (toIndex < 0) toIndex = 0;
      if (toIndex > tokens.length) toIndex = tokens.length;
      if (toIndex >= fromStart && toIndex <= fromEnd + 1) return state;

      const movedSlice = tokens.slice(fromStart, fromEnd + 1);
      if (movedSlice.length === 0 || movedSlice.some((tok) => tok.kind === "empty")) return state;

      const originalIds = new Set(
        state.present.originalTokens.filter((tok) => tok.kind !== "empty").map((tok) => tok.id)
      );
      const hasOriginalAnchor = movedSlice.some((tok) =>
        unwindToOriginal([tok]).some((orig) => originalIds.has(orig.id))
      );
      if (!hasOriginalAnchor) {
        tokens.splice(fromStart, movedSlice.length);
        let insertionIndex = toIndex;
        if (toIndex > fromEnd + 1) {
          insertionIndex -= movedSlice.length;
        }
        insertionIndex = Math.max(0, Math.min(tokens.length, insertionIndex));
        const leadingSpace = getLeadingSpace(tokens, insertionIndex);
        const floatingGroupId = createId();
        const movedTokens = movedSlice.map((tok, idx) => ({
          ...tok,
          origin: "inserted",
          groupId: floatingGroupId,
          moveId: undefined,
          previousTokens: [makeEmptyPlaceholder([])],
          spaceBefore: idx === 0 ? leadingSpace : tok.spaceBefore,
        }));
        tokens.splice(insertionIndex, 0, ...movedTokens);
        const next: EditorPresentState = { ...state.present, tokens };
        return pushPresent(state, next);
      }

      // If the selection is an existing move destination, reuse the same moveId and placeholder.
      const sameMoveId =
        movedSlice.every((t) => t.moveId) && movedSlice.every((t) => t.moveId === movedSlice[0].moveId);
      const existingMarker =
        sameMoveId && movedSlice[0].moveId ? deriveMoveMarkers(tokens).find((m) => m.id === movedSlice[0].moveId) : null;
      if (existingMarker) {
        const moveId = existingMarker.id;
        // Prevent dropping into the placeholder span.
        if (toIndex >= existingMarker.fromStart && toIndex <= existingMarker.fromEnd + 1) {
          return state;
        }
        // Remove existing destination tokens entirely.
        const removedDest = tokens.splice(existingMarker.toStart, existingMarker.toEnd - existingMarker.toStart + 1);
        // Adjust insertion index after removal.
        let insertionIndex = toIndex;
        if (insertionIndex > existingMarker.toStart) {
          insertionIndex -= removedDest.length;
        }
        // If placeholder sits before insertion and was not removed, account for it.
        if (insertionIndex > existingMarker.fromStart && insertionIndex <= existingMarker.fromEnd + 1) {
          insertionIndex = existingMarker.fromEnd + 1;
        }
        insertionIndex = Math.max(0, Math.min(tokens.length, insertionIndex));

        const leadingSpace = getLeadingSpace(tokens, insertionIndex);
        const movedTokens = removedDest.map((tok, idx) => ({
          ...tok,
          groupId: `move-dest-${moveId}`,
          moveId,
          spaceBefore: idx === 0 ? leadingSpace : tok.spaceBefore,
        }));
        tokens.splice(insertionIndex, 0, ...movedTokens);
        const cleaned = dropRedundantEmpties(tokens);
        const next: EditorPresentState = { ...state.present, tokens: cleaned };
        return pushPresent(state, next);
      }

      const placeholderHistory = restoreHistoryTokens(movedSlice);
      const groupHistory = new Map<string, Token[]>();
      movedSlice.forEach((tok) => {
        if (!tok.groupId || groupHistory.has(tok.groupId)) return;
        if (tok.previousTokens?.length) {
          groupHistory.set(tok.groupId, dedupeTokens(unwindToOriginal(cloneTokens(tok.previousTokens))));
        }
      });
      const moveId = `move-${createId()}`;
      const placeholder = buildPlaceholderToken(placeholderHistory, {
        groupId: `move-src-${moveId}`,
        moveId,
        spaceBefore: movedSlice[0]?.spaceBefore ?? true,
      });

      tokens.splice(fromStart, movedSlice.length);
      tokens.splice(fromStart, 0, placeholder);

      let insertionIndex = toIndex;
      if (toIndex > fromEnd + 1) {
        insertionIndex -= movedSlice.length;
      }
      if (insertionIndex >= fromStart) {
        insertionIndex += 1;
      }
      insertionIndex = Math.max(0, Math.min(tokens.length, insertionIndex));

      const leadingSpace = getLeadingSpace(tokens, insertionIndex);
      const movedTokens = movedSlice.map((tok, idx) => ({
        ...tok,
        groupId: `move-dest-${moveId}`,
        moveId,
        previousTokens: tok.previousTokens?.length ? cloneTokens(tok.previousTokens) : cloneTokens(placeholderHistory),
        spaceBefore: idx === 0 ? leadingSpace : tok.spaceBefore,
      }));
      tokens.splice(insertionIndex, 0, ...movedTokens);
      if (groupHistory.size) {
        tokens.forEach((tok) => {
          if (!tok.groupId || tok.previousTokens?.length) return;
          const history = groupHistory.get(tok.groupId);
          if (history) {
            tok.previousTokens = cloneTokens(history);
          }
        });
      }

      const next: EditorPresentState = { ...state.present, tokens };
      return pushPresent(state, next);
    }
    case "REVERT_MOVE": {
      const tokens = cloneTokens(state.present.tokens);
      const markers = deriveMoveMarkers(tokens);
      const marker = markers.find((m) => m.id === action.moveId);
      if (!marker) return state;

      const destLen = marker.toEnd - marker.toStart + 1;
      tokens.splice(marker.toStart, destLen);

      let placeholderIndex = marker.fromStart;
      if (marker.toStart < marker.fromStart) {
        placeholderIndex -= destLen;
      }
      const placeholderSpan = marker.fromEnd - marker.fromStart + 1;
      const placeholder = tokens.slice(placeholderIndex, placeholderIndex + placeholderSpan).find((t) => t.moveId === action.moveId && t.kind === "empty");
      const history = placeholder?.previousTokens?.length
        ? restoreHistoryTokens(placeholder.previousTokens)
        : [];
      tokens.splice(placeholderIndex, placeholderSpan, ...history);
      const cleaned = dropRedundantEmpties(tokens);
      const next: EditorPresentState = { ...state.present, tokens: cleaned };
      return pushPresent(state, next);
    }
    case "INSERT_TOKEN_BEFORE_SELECTED": {
      if (!action.range) return state;
      const [start] = action.range;
      const tokens = cloneTokens(state.present.tokens);
      const leadingSpace = getLeadingSpace(tokens, start);
      const inserted: Token = {
        id: createId(),
        text: "",
        kind: "word",
        selected: false,
        // Show a placeholder history so the annotator sees the implicit ⬚.
        previousTokens: [makeEmptyPlaceholder([])],
        origin: "inserted",
        spaceBefore: leadingSpace,
      };
      tokens.splice(start, 0, inserted);
      const next: EditorPresentState = { ...state.present, tokens };
      // Do NOT push to history yet; this is a transient insertion until user confirms.
      return { ...state, present: next, future: [] };
    }
    case "INSERT_TOKEN_AFTER_SELECTED": {
      if (!action.range) return state;
      const tokens = cloneTokens(state.present.tokens);
      const [, end] = action.range;
      const nextToken = tokens[end + 1];
      const leadingSpace = end === tokens.length - 1 ? true : nextToken?.spaceBefore !== false;
      const inserted: Token = {
        id: createId(),
        text: "",
        kind: "word",
        selected: false,
        previousTokens: [makeEmptyPlaceholder([])],
        origin: "inserted",
        spaceBefore: leadingSpace,
      };
      tokens.splice(end + 1, 0, inserted);
      const next: EditorPresentState = { ...state.present, tokens };
      // Do NOT push to history yet; this is a transient insertion until user confirms.
      return { ...state, present: next, future: [] };
    }
    case "EDIT_SELECTED_RANGE_AS_TEXT": {
      let [start, end] = action.range;
      const tokens = cloneTokens(state.present.tokens);
      // Always expand the edit to the full correction group so re-edits stay in-place.
      const gid = tokens[start]?.groupId;
      if (gid) {
        [start, end] = expandRangeByGroupKey(tokens, start, end, (tok) =>
          tok?.groupId === gid ? gid : null
        );
      }
      let oldSlice = tokens.slice(start, end + 1);
      const leadingSpace = getLeadingSpace(tokens, start);
      const hasExplicitLeadingSpace = /^\s/.test(action.newText);
      const whitespaceOnly = /^\s+$/.test(action.newText);
      let newTokensRaw = tokenizeEditedText(action.newText);
      if (whitespaceOnly) {
        let nextIndex = end + 1;
        while (nextIndex < tokens.length && tokens[nextIndex]?.kind === "empty") {
          nextIndex += 1;
        }
        if (nextIndex < tokens.length) {
          end = nextIndex;
          oldSlice = tokens.slice(start, end + 1);
          const nextToken = tokens[nextIndex];
          newTokensRaw = [
            {
              id: createId(),
              text: nextToken.text,
              kind: nextToken.kind,
              selected: false,
              spaceBefore: true,
              origin: nextToken.origin,
            },
          ];
        }
      }
      const oldSliceAllInserted = oldSlice.every((tok) => tok.origin === "inserted");
      const moveIdReuse =
        oldSlice.length > 0 && oldSlice.every((tok) => tok.moveId === oldSlice[0].moveId)
          ? oldSlice[0].moveId
          : undefined;
      const flattenedOld: Token[] = [];
      oldSlice.forEach((tok) => {
        flattenedOld.push({ ...tok, selected: false });
        if (tok.previousTokens) {
          flattenedOld.push(...cloneTokens(tok.previousTokens));
        }
      });
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
      const existingGroupId =
        oldSlice.length > 0 && oldSlice.every((tok) => tok.groupId === oldSlice[0].groupId) ? oldSlice[0].groupId : null;
      const anchorExistingHistory =
        oldSlice.find((tok) => tok.previousTokens && tok.previousTokens.length) ??
        (existingGroupId ? tokens.find((t) => t.groupId === existingGroupId && t.previousTokens && t.previousTokens.length) : undefined);
      const reuseHistory = Boolean(existingGroupId && anchorExistingHistory?.previousTokens?.length);
      const baseHistoryRaw = reuseHistory ? cloneTokens(anchorExistingHistory!.previousTokens!) : flattenedOld;
      const baseHistory = dedupeTokens(unwindToOriginal(baseHistoryRaw));
      const baseVisible = baseHistory.filter((t) => t.kind !== "empty");

      // If the new text matches the original visible tokens exactly, treat this as a full revert.
      if (newTokensRaw.length && sameTokenSequence(baseVisible, newTokensRaw)) {
        tokens.splice(start, oldSlice.length, ...restoreHistoryTokens(baseVisible));
        const cleaned = dropRedundantEmpties(tokens);
        const next: EditorPresentState = {
          ...state.present,
          tokens: cleaned,
        };
        return pushPresent(state, next);
      }

      const groupId = reuseHistory && existingGroupId ? existingGroupId : createId();
      let replacement: Token[] = newTokensRaw.length
        ? cloneTokens(newTokensRaw).map((tok) => ({ ...tok, groupId, moveId: moveIdReuse }))
        : [buildPlaceholderToken([], { moveId: moveIdReuse })];
      if (oldSliceAllInserted) {
        replacement = replacement.map((tok) => ({ ...tok, origin: "inserted" }));
      }
      if (replacement.length) {
        const replacementLeadingSpace = newTokensRaw.length
          ? hasExplicitLeadingSpace || leadingSpace
          : leadingSpace;
        replacement[0].spaceBefore = replacementLeadingSpace;
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
      const next: EditorPresentState = { ...state.present, tokens };
      if (oldSliceAllInserted) {
        // Do not record the transient empty insertion; push the pre-insert snapshot instead.
        const preInsertTokens = cloneTokens(state.present.tokens);
        preInsertTokens.splice(start, oldSlice.length); // remove the placeholder slice
        const pastEntry: EditorPresentState = {
          ...state.present,
          tokens: preInsertTokens,
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
      const moveIdReuse =
        slice.length > 0 && slice.every((tok) => tok.moveId === slice[0].moveId)
          ? slice[0].moveId
          : undefined;
      // Preserve insertion origin if everything in the slice was originally inserted.
      if (slice.every((tok) => tok.origin === "inserted")) {
        merged.origin = "inserted";
      }
      merged.moveId = moveIdReuse;
      tokens.splice(start, slice.length, merged);
      const nextState: EditorPresentState = { ...state.present, tokens };
      return pushPresent(state, nextState);
    }
    case "CLEAR_ALL": {
      const original = state.present.originalTokens;
      const present: EditorPresentState = {
        originalTokens: cloneTokens(original),
        tokens: cloneTokens(original),
      };
      return pushPresent(state, present);
    }
    case "REVERT_CORRECTION": {
      const { rangeStart, rangeEnd } = action;
      const tokens = cloneTokens(state.present.tokens);
      // Revert standard correction by replacing range with previousTokens found in the anchor.
      const anchorIdx = tokens.findIndex(
        (tok, idx) =>
          idx >= rangeStart && idx <= rangeEnd && tok.previousTokens && tok.previousTokens.length
      );
      if (anchorIdx === -1) return state;
      const replacementRaw = tokens[anchorIdx].previousTokens?.length
        ? cloneTokens(tokens[anchorIdx].previousTokens!)
        : [makeEmptyPlaceholder([])];
      const replacement = restoreHistoryTokens(replacementRaw);
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
      const next: EditorPresentState = { ...state.present, tokens: cleaned };
      return pushPresent(state, next);
    }
    case "MERGE_WITH_NEXT": {
      const tokens = cloneTokens(state.present.tokens);
      if (action.index < 0 || action.index >= tokens.length - 1) return state;
      const current = tokens[action.index];
      const nextToken = tokens[action.index + 1];

      const merged = buildMergedToken([current, nextToken]);
      if (!merged) return state;
      const moveIdReuse =
        current.moveId && current.moveId === nextToken.moveId ? current.moveId : undefined;
      merged.moveId = moveIdReuse;
      tokens.splice(action.index, 2, merged);
      const nextState: EditorPresentState = { ...state.present, tokens };
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
      const next: EditorPresentState = { ...state.present, tokens };
      // Transient cleanup; do not push to history.
      return { ...state, present: next, future: [] };
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

const reducer = (state: EditorHistoryState, action: Action): EditorHistoryState => {
  if (action.type === "INIT_FROM_TEXT") {
    const original = tokenizeToTokens(action.text);
    const present = buildPresentFromOperations(original, []);
    return { past: [], present, future: [] };
  }
  if (action.type === "INIT_FROM_STATE") {
    const hasMoveMarkers = deriveMoveMarkers(action.state.tokens ?? []).length > 0;
    if (!hasMoveMarkers && Array.isArray(action.state.operations) && action.state.operations.length > 0) {
      const present = buildPresentFromOperations(action.state.originalTokens, action.state.operations);
      return { past: [], present, future: [] };
    }
    const present = buildPresentWithDerivedOperations(action.state);
    return { past: [], present, future: [] };
  }
  const normalized = normalizeHistoryState(state);
  const next = tokenReducer(normalized, action);
  return normalizeHistoryState(next);
};

export const tokenEditorReducer = reducer;

const formatTokensWithBreaks = (tokens: Token[], breaks: number[] = []) => {
  const breakCounts = new Map<number, number>();
  breaks.forEach((idx) => {
    breakCounts.set(idx, (breakCounts.get(idx) ?? 0) + 1);
  });
  let visibleIdx = 0;
  let atLineStart = true;
  let result = "";
  tokens.forEach((t) => {
    if (t.kind === "empty") return;
    const needsSpace = !atLineStart && t.spaceBefore !== false;
    if (needsSpace) result += " ";
    result += t.text;
    visibleIdx += 1;
    const count = breakCounts.get(visibleIdx) ?? 0;
    if (count > 0) {
      result += "\n".repeat(count);
      atLineStart = true;
    } else {
      atLineStart = false;
    }
  });
  return result;
};

// Concatenate token texts for editing field and plain-text preview, skipping empty placeholders.
export const buildEditableTextFromTokens = (tokens: Token[]) => formatTokensWithBreaks(tokens);

export const buildTextFromTokens = (tokens: Token[]) => buildEditableTextFromTokens(tokens);

export const buildTextFromTokensWithBreaks = (tokens: Token[], breaks: number[]) =>
  formatTokensWithBreaks(tokens, breaks);

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

export const annotationsSignature = (annotations: AnnotationDraft[]) =>
  JSON.stringify(
    annotations.map(({ id, ...rest }) => rest)
  );

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
  annotationDeleteMap?: Map<string, number[]>;
  includeDeletedIds?: boolean;
  allowUnassigned?: boolean;
  defaultErrorTypeId?: number;
  includeClientCorrectionId?: boolean;
};

export const buildAnnotationsPayloadStandalone = async ({
  initialText,
  tokens,
  originalTokens,
  correctionCards,
  correctionTypeMap,
  moveMarkers,
  annotationIdMap,
  annotationDeleteMap,
  includeDeletedIds = false,
  allowUnassigned = false,
  defaultErrorTypeId = 0,
  includeClientCorrectionId = false,
}: BuildPayloadInput): Promise<AnnotationDraft[]> => {
  const textHash = await computeSha256(initialText);
  const textTokensSnapshot = originalTokens.filter((t) => t.kind !== "empty").map((t) => t.text);
  const textTokensHash = await computeTokensSha256(textTokensSnapshot);
  const originalIndexById = new Map<string, number>();
  const originalTokenById = new Map<string, Token>();
  originalTokens.forEach((tok, idx) => {
    if (tok.kind === "empty") return;
    originalIndexById.set(tok.id, idx);
    originalTokenById.set(tok.id, tok);
  });

  const seenKeys = new Set<string>();
  const payloads: AnnotationDraft[] = [];
  const normalizeBeforeIds = (items: Token[]) => {
    const seen = new Set<string>();
    const ids: string[] = [];
    items.forEach((tok) => {
      if (tok.kind === "empty") return;
      if (!originalIndexById.has(tok.id)) return;
      if (seen.has(tok.id)) return;
      seen.add(tok.id);
      ids.push(tok.id);
    });
    return ids;
  };

  const textForIds = (ids: string[]) =>
    ids
      .map((id) => originalTokenById.get(id)?.text ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();

  const fragmentFromToken = buildTokenFragment;

  const moveMarkerById = new Map<string, MoveMarker>();
  moveMarkers.forEach((marker) => moveMarkerById.set(marker.id, marker));
  const moveTargetById = new Map<string, { start: number; end: number }>();
  const movedOriginalIds = new Set<string>();
  moveMarkers.forEach((marker) => {
    const sourceToken = tokens[marker.fromStart];
    const historyTokens = sourceToken?.previousTokens?.length
      ? unwindToOriginal(cloneTokens(sourceToken.previousTokens))
      : [];
    const beforeIds = normalizeBeforeIds(historyTokens);
    beforeIds.forEach((id) => movedOriginalIds.add(id));
    const movedIndices: number[] = [];
    tokens.forEach((tok, idx) => {
      if (tok.kind !== "empty" && tok.moveId === marker.id) {
        movedIndices.push(idx);
      }
    });
    const moveRangeStart = movedIndices.length ? Math.min(...movedIndices) : marker.toStart;
    const moveRangeEnd = movedIndices.length ? Math.max(...movedIndices) : marker.toEnd;
    const movedTokens = tokens
      .slice(moveRangeStart, moveRangeEnd + 1)
      .filter((tok) => tok.kind !== "empty" && tok.moveId === marker.id);
    const moveTo = findInsertionIndexFromTokens(
      tokens,
      originalIndexById,
      moveRangeStart,
      moveRangeEnd,
      undefined,
      true
    );
    const moveLength = Math.max(1, beforeIds.length || movedTokens.length || 1);
    moveTargetById.set(marker.id, { start: moveTo, end: moveTo + moveLength - 1 });
  });
  const findInsertionIndex = (rangeStart: number, rangeEnd: number) =>
    findInsertionIndexFromTokens(tokens, originalIndexById, rangeStart, rangeEnd, moveTargetById);

  correctionCards.forEach((card) => {
    let typeId = correctionTypeMap[card.id];
    if (typeId == null) {
      if (!allowUnassigned) return;
      typeId = defaultErrorTypeId;
    }
    const key = `${card.rangeStart}-${card.rangeEnd}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    const moveMarker = moveMarkerById.get(card.id);
    if (moveMarker) {
      const sourceToken = tokens[moveMarker.fromStart];
      const historyTokens = sourceToken?.previousTokens?.length
        ? unwindToOriginal(cloneTokens(sourceToken.previousTokens))
        : [];
      const beforeIds = normalizeBeforeIds(historyTokens);
      const movedIndices: number[] = [];
      tokens.forEach((tok, idx) => {
        if (tok.kind !== "empty" && tok.moveId === moveMarker.id) {
          movedIndices.push(idx);
        }
      });
      const moveRangeStart = movedIndices.length ? Math.min(...movedIndices) : moveMarker.toStart;
      const moveRangeEnd = movedIndices.length ? Math.max(...movedIndices) : moveMarker.toEnd;
      const movedTokens = tokens
        .slice(moveRangeStart, moveRangeEnd + 1)
        .filter((tok) => tok.kind !== "empty" && tok.moveId === moveMarker.id);
      const afterFragments = movedTokens.map(fragmentFromToken);
      const moveFromIndices = beforeIds
        .map((id) => originalIndexById.get(id))
        .filter((idx): idx is number => idx !== undefined);
      const moveFrom = moveFromIndices.length
        ? Math.min(...moveFromIndices)
        : findInsertionIndexFromTokens(
            tokens,
            originalIndexById,
            moveMarker.fromStart,
            moveMarker.fromEnd,
            undefined,
            true
          );
      const targetSpan = moveTargetById.get(moveMarker.id);
      const moveTo =
        targetSpan?.start ??
        findInsertionIndexFromTokens(tokens, originalIndexById, moveRangeStart, moveRangeEnd, undefined, true);
      const moveLength = targetSpan ? targetSpan.end - targetSpan.start + 1 : Math.max(1, beforeIds.length || afterFragments.length || 1);
      const replacement = afterFragments.length ? afterFragments.map((f) => f.text).join(" ").trim() : null;
      const payload: AnnotationDetailPayload = {
        text_sha256: textHash,
        text_tokens: textTokensSnapshot,
        text_tokens_sha256: textTokensHash ?? undefined,
        operation: "move",
        before_tokens: beforeIds,
        after_tokens: afterFragments,
        source: "manual",
        move_from: moveFrom,
        move_to: moveTo,
        move_len: moveLength,
      };
      if (includeClientCorrectionId) {
        payload.client_correction_id = card.id;
      }
      const spanStart = moveTo;
      const spanEnd = moveTo + moveLength - 1;
      const draft: AnnotationDraft = {
        start_token: spanStart,
        end_token: spanEnd,
        replacement,
        error_type_id: typeId,
        payload,
      };
      const spanKey = buildSpanKey(spanStart, spanEnd);
      const existingId = annotationIdMap?.get(spanKey);
      if (existingId !== undefined) {
        draft.id = existingId;
      }
      payloads.push(draft);
      return;
    }

    const historyTokens: Token[] = [];
    for (let idx = card.rangeStart; idx <= card.rangeEnd; idx += 1) {
      const tok = tokens[idx];
      if (tok?.previousTokens?.length) {
        historyTokens.push(...unwindToOriginal(tok.previousTokens));
      }
    }
    if (!historyTokens.length) {
      const groupId = tokens[card.rangeStart]?.groupId ?? tokens[card.rangeEnd]?.groupId;
      if (groupId) {
        tokens.forEach((tok) => {
          if (tok.groupId !== groupId) return;
          if (tok.previousTokens?.length) {
            historyTokens.push(...unwindToOriginal(tok.previousTokens));
          }
        });
      }
    }
    const currentVisible = tokens
      .slice(card.rangeStart, card.rangeEnd + 1)
      .filter((tok) => tok.kind !== "empty");
    const currentAllInserted =
      currentVisible.length > 0 && currentVisible.every((tok) => tok.origin === "inserted");
    if (!historyTokens.length && !currentAllInserted) {
      historyTokens.push(
        ...originalTokens.slice(card.rangeStart, card.rangeEnd + 1).filter((tok) => tok.kind !== "empty")
      );
    }
    const historyVisible = historyTokens.filter((tok) => tok.kind !== "empty");
    const beforeIds = normalizeBeforeIds(historyVisible);
    const afterFragments = tokens
      .slice(card.rangeStart, card.rangeEnd + 1)
      .filter((tok) => tok.kind !== "empty")
      .map(fragmentFromToken);
    const beforeText = textForIds(beforeIds);
    const afterText = afterFragments.map((f) => f.text).join(" ").trim();
    const beforeTextRaw = buildEditableTextFromTokens(historyVisible);
    const afterTextRaw = buildEditableTextFromTokens(currentVisible);
    const whitespaceChanged = beforeTextRaw !== afterTextRaw;
    let operation: AnnotationDetailPayload["operation"] = "replace";
    if (!afterFragments.length || afterText === "") {
      operation = "delete";
    } else if (!beforeIds.length) {
      operation = "insert";
    } else if (beforeText === afterText && !whitespaceChanged) {
      operation = "noop";
    }
    const hasOriginalInCurrent = currentVisible.some((tok) => originalIndexById.has(tok.id));
    if (
      operation === "replace" &&
      beforeIds.length &&
      !hasOriginalInCurrent &&
      beforeIds.every((id) => movedOriginalIds.has(id))
    ) {
      operation = "insert";
    }

    const anchorIds =
      operation === "insert" && beforeIds.length === 0 && card.rangeStart > 0
        ? (() => {
            const anchorToken = tokens[card.rangeStart - 1];
            if (!anchorToken?.moveId || !anchorToken.previousTokens?.length) return [];
            const anchorHistory = unwindToOriginal(cloneTokens(anchorToken.previousTokens));
            return normalizeBeforeIds(anchorHistory);
          })()
        : [];
    const payloadBeforeIds = anchorIds.length ? anchorIds : beforeIds;
    const replacement = afterFragments.length === 0 ? null : afterFragments.map((f) => f.text).join(" ").trim() || null;
    const beforeIndices = operation === "insert"
      ? []
      : payloadBeforeIds
          .map((id) => originalIndexById.get(id))
          .filter((idx): idx is number => idx !== undefined);
    const insertionIndex = findInsertionIndex(card.rangeStart, card.rangeEnd);
    const spanStart = beforeIndices.length ? Math.min(...beforeIndices) : insertionIndex;
    const spanEnd = beforeIndices.length ? Math.max(...beforeIndices) : insertionIndex;

    const payload: AnnotationDetailPayload = {
      text_sha256: textHash,
      text_tokens: textTokensSnapshot,
      text_tokens_sha256: textTokensHash ?? undefined,
      operation,
      before_tokens: payloadBeforeIds,
      after_tokens: afterFragments,
      source: "manual",
    };
    if (includeClientCorrectionId) {
      payload.client_correction_id = card.id;
    }
    const draft: AnnotationDraft = {
      start_token: spanStart,
      end_token: spanEnd,
      replacement,
      error_type_id: typeId,
      payload,
    };
    const spanKey = buildSpanKey(spanStart, spanEnd);
    const existingId = annotationIdMap?.get(spanKey);
    if (existingId !== undefined) {
      draft.id = existingId;
    }
    payloads.push(draft);
  });

  if (includeDeletedIds && (annotationDeleteMap || annotationIdMap)) {
    const spanKeys = new Set(payloads.map((p) => buildSpanKey(p.start_token, p.end_token)));
    const sourceMap = annotationDeleteMap ?? new Map<string, number[]>();
    const deletedIds: number[] = [];
    if (annotationDeleteMap) {
      annotationDeleteMap.forEach((ids, span) => {
        if (!spanKeys.has(span)) {
          deletedIds.push(...ids);
        }
      });
    }
    if (!annotationDeleteMap && annotationIdMap) {
      annotationIdMap.forEach((id, span) => {
        if (!spanKeys.has(span)) {
          deletedIds.push(id);
        }
      });
    }
    (payloads as any).deleted_ids = Array.from(new Set(deletedIds));
  }

  return payloads;
};
