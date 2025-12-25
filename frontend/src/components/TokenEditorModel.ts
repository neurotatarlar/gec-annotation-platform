import { AnnotationDetailPayload, AnnotationDraft, ErrorType, TokenFragmentPayload } from "../types";

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
  | { type: "DELETE_SELECTED_TOKENS"; range: [number, number] }
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
const punctuation = /[^\p{L}\p{N}\s]/u;
let idCounter = 0;
export const createId = () => `token-${idCounter++}`;

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
        spaceBefore: hadSpace,
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
    const isWord = /[\p{L}\p{N}]/u.test(part);
    tokens.push({
      id: createId(),
      text: part,
      kind: isWord ? "word" : "punct",
      selected: false,
      spaceBefore,
      origin: undefined,
    });
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

export const makeEmptyPlaceholder = (previousTokens: Token[]): Token => ({
  id: createId(),
  text: "⬚",
  kind: "empty",
  selected: false,
  previousTokens,
  origin: undefined,
});

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

export const deriveCorrectionCards = (tokens: Token[], moveMarkers: MoveMarker[]): CorrectionCardLite[] => {
  const visited = new Set<number>();
  const baseCards = tokens
    .map((tok, idx) => {
      if (visited.has(idx)) return null;
      if (tok.moveId) return null;
      if (!tok.previousTokens?.length) return null;
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

const buildTokensFromFragments = (
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
    const explicitSpace =
      typeof (frag as any)?.space_before === "boolean"
        ? (frag as any).space_before
        : typeof (frag as any)?.spaceBefore === "boolean"
          ? (frag as any).spaceBefore
          : undefined;
    const baseTokens = tokenizeEditedText(text);
    baseTokens.forEach((tok, idx) => {
      let spaceBefore = tok.spaceBefore;
      if (idx === 0) {
        if (explicitSpace !== undefined) {
          spaceBefore = explicitSpace;
        } else if (fragIndex > 0) {
          spaceBefore = true;
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
    const leadingSpace = targetStart === 0 ? false : working[targetStart]?.spaceBefore !== false;
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
        {
          ...makeEmptyPlaceholder(history),
          id: `${op.id}-ph`,
          groupId: op.id,
          spaceBefore: leadingSpace,
        },
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
      newTokens[0].spaceBefore = leadingSpace;
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

  const getOriginalSpanForToken = (tok: Token): { min: number; max: number } | null => {
    const indices: number[] = [];
    const direct = originalIndexById.get(tok.id);
    if (direct !== undefined) indices.push(direct);
    if (tok.previousTokens?.length) {
      const originals = unwindToOriginal(cloneTokens(tok.previousTokens));
      originals.forEach((prev) => {
        const idx = originalIndexById.get(prev.id);
        if (idx !== undefined) indices.push(idx);
      });
    }
    if (!indices.length) return null;
    return { min: Math.min(...indices), max: Math.max(...indices) };
  };

  const findInsertionIndex = (rangeStart: number, rangeEnd: number) => {
    for (let i = rangeStart - 1; i >= 0; i -= 1) {
      const span = getOriginalSpanForToken(tokens[i]);
      if (span) return span.max + 1;
    }
    for (let i = rangeEnd + 1; i < tokens.length; i += 1) {
      const span = getOriginalSpanForToken(tokens[i]);
      if (span) return span.min;
    }
    return 0;
  };

  const tokensToFragments = (items: Token[]): TokenFragmentPayload[] =>
    items
      .filter((tok) => tok.kind !== "empty" && tok.text !== "")
      .map((tok) => {
        const fragment: TokenFragmentPayload = {
          text: tok.text,
          origin: tok.origin === "inserted" ? "inserted" : "base",
        };
        if (typeof tok.spaceBefore === "boolean") {
          fragment.space_before = tok.spaceBefore;
        }
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
    const baseHistory = dedupeTokens(unwindToOriginal(historyTokens)).filter((t) => t.kind !== "empty");
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
    const spanStart = baseIndices.length ? Math.min(...baseIndices) : findInsertionIndex(rangeStart, rangeEnd);
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
      const leadingSpace = start === 0 ? false : tokens[start]?.spaceBefore !== false;
      const removed = tokens.slice(start, end + 1);
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
        const restore = dedupeTokens(unwindToOriginal(cloneTokens(anchorWithHistory.previousTokens!))).map((tok) => ({
          ...tok,
          previousTokens: undefined,
          selected: false,
          origin: tok.origin,
          moveId: undefined,
        }));
        tokens.splice(start, removed.length, ...restore);
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
      const previousTokens = dedupeTokens(removed.flatMap((t) => unwindToOriginal([t])).map((tok) => ({ ...tok, selected: false })));
      if (!previousTokens.length) {
        previousTokens.push(makeEmptyPlaceholder([]));
      }
      const placeholder = makeEmptyPlaceholder(previousTokens);
      placeholder.spaceBefore = leadingSpace;
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

        const leadingSpace = insertionIndex === 0 ? false : tokens[insertionIndex]?.spaceBefore !== false;
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

      const placeholderHistory = dedupeTokens(unwindToOriginal(movedSlice)).map((tok) => ({
        ...tok,
        previousTokens: undefined,
        selected: false,
        groupId: undefined,
        moveId: undefined,
      }));
      const moveId = `move-${createId()}`;
      const placeholder = {
        ...makeEmptyPlaceholder(placeholderHistory),
        groupId: `move-src-${moveId}`,
        moveId,
        spaceBefore: movedSlice[0]?.spaceBefore ?? true,
      };

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

      const leadingSpace = insertionIndex === 0 ? false : tokens[insertionIndex]?.spaceBefore !== false;
      const movedTokens = movedSlice.map((tok, idx) => ({
        ...tok,
        groupId: `move-dest-${moveId}`,
        moveId,
        spaceBefore: idx === 0 ? leadingSpace : tok.spaceBefore,
      }));
      tokens.splice(insertionIndex, 0, ...movedTokens);

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
      const history =
        placeholder?.previousTokens?.length
          ? dedupeTokens(unwindToOriginal(cloneTokens(placeholder.previousTokens))).map((t) => ({
              ...t,
              selected: false,
              previousTokens: undefined,
              moveId: undefined,
              groupId: undefined,
            }))
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
      const leadingSpace = start === 0 ? false : tokens[start]?.spaceBefore !== false;
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
        while (start - 1 >= 0 && tokens[start - 1]?.groupId === gid) start -= 1;
        while (end + 1 < tokens.length && tokens[end + 1]?.groupId === gid) end += 1;
      }
      const oldSlice = tokens.slice(start, end + 1);
      const leadingSpace = start === 0 ? false : oldSlice[0]?.spaceBefore !== false;
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
      const newTokensRaw = tokenizeEditedText(action.newText);
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
        const restored = baseVisible.map((tok) => ({
          ...tok,
          selected: false,
          previousTokens: undefined,
          groupId: undefined,
          moveId: undefined,
        }));
        tokens.splice(start, oldSlice.length, ...restored);
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
        : [{ ...makeEmptyPlaceholder([]), moveId: moveIdReuse }];
      if (oldSliceAllInserted) {
        replacement = replacement.map((tok) => ({ ...tok, origin: "inserted" }));
      }
      if (replacement.length) {
        replacement[0].spaceBefore = leadingSpace;
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
      const replacement = dedupeTokens(unwindToOriginal(replacementRaw)).map((tok) => ({
        ...tok,
        previousTokens: undefined,
        selected: false,
        moveId: undefined,
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
    if (Array.isArray(action.state.operations) && action.state.operations.length > 0) {
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

// Concatenate token texts for editing field and plain-text preview, skipping empty placeholders.
export const buildTextFromTokens = (tokens: Token[]) =>
  tokens
    .filter((t) => t.kind !== "empty")
    .map((t) => t.text)
    .join(" ")
    .replace(/\s+([.,;:?!-])/g, "$1");

export const buildTextFromTokensWithBreaks = (tokens: Token[], breaks: number[]) => {
  const breakCounts = new Map<number, number>();
  breaks.forEach((idx) => {
    breakCounts.set(idx, (breakCounts.get(idx) ?? 0) + 1);
  });
  const parts: string[] = [];
  let visibleIdx = 0;
  tokens.forEach((t) => {
    if (t.kind === "empty") return;
    parts.push(t.text);
    visibleIdx += 1;
    const count = breakCounts.get(visibleIdx) ?? 0;
    if (count > 0) {
      for (let i = 0; i < count; i += 1) {
        parts.push("\n");
      }
    }
  });
  const joined = parts.join(" ");
  return joined.replace(/\s+([.,;:?!-])/g, "$1").replace(/[ \t]*\n[ \t]*/g, "\n").trimEnd();
};

export const buildEditableTextFromTokens = (tokens: Token[]) => {
  const visible = tokens.filter((t) => t.kind !== "empty");
  if (!visible.length) return "";
  return visible
    .map((t, idx) => {
      const needsSpace = idx === 0 ? false : t.spaceBefore !== false;
      const prefix = needsSpace ? " " : "";
      return `${prefix}${t.text}`;
    })
    .join("");
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
  correctionCards?: CorrectionCardLite[];
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
  includeDeletedIds?: boolean;
};

export const buildAnnotationsPayloadStandalone = async ({
  initialText,
  tokens,
  originalTokens,
  correctionCards,
  correctionTypeMap,
  moveMarkers,
  annotationIdMap,
  includeDeletedIds = false,
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

  const getOriginalSpanForToken = (tok: Token): { min: number; max: number } | null => {
    const indices: number[] = [];
    const direct = originalIndexById.get(tok.id);
    if (direct !== undefined) {
      indices.push(direct);
    }
    if (tok.previousTokens?.length) {
      const originals = unwindToOriginal(cloneTokens(tok.previousTokens));
      originals.forEach((prev) => {
        const idx = originalIndexById.get(prev.id);
        if (idx !== undefined) indices.push(idx);
      });
    }
    if (!indices.length) return null;
    return { min: Math.min(...indices), max: Math.max(...indices) };
  };

  const findInsertionIndex = (rangeStart: number, rangeEnd: number) => {
    for (let i = rangeStart - 1; i >= 0; i -= 1) {
      const span = getOriginalSpanForToken(tokens[i]);
      if (span) return span.max + 1;
    }
    for (let i = rangeEnd + 1; i < tokens.length; i += 1) {
      const span = getOriginalSpanForToken(tokens[i]);
      if (span) return span.min;
    }
    return 0;
  };

  const fragmentFromToken = (tok: Token): TokenFragmentPayload => {
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

  const moveMarkerById = new Map<string, MoveMarker>();
  moveMarkers.forEach((marker) => moveMarkerById.set(marker.id, marker));

  correctionCards.forEach((card) => {
    const typeId = correctionTypeMap[card.id];
    if (!typeId) return;
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
      const afterFragments = tokens
        .slice(moveMarker.toStart, moveMarker.toEnd + 1)
        .filter((tok) => tok.kind !== "empty")
        .map(fragmentFromToken);
      const moveFromIndices = beforeIds
        .map((id) => originalIndexById.get(id))
        .filter((idx): idx is number => idx !== undefined);
      const moveFrom = moveFromIndices.length ? Math.min(...moveFromIndices) : moveMarker.fromStart;
      const moveTo = findInsertionIndex(moveMarker.toStart, moveMarker.toEnd);
      const moveLength = Math.max(1, afterFragments.length || 1);
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
      const spanStart = moveTo;
      const spanEnd = moveTo + moveLength - 1;
      const draft: AnnotationDraft = {
        start_token: spanStart,
        end_token: spanEnd,
        replacement,
        error_type_id: typeId,
        payload,
      };
      const spanKey = `${spanStart}-${spanEnd}`;
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
        historyTokens.push(...unwindToOriginal(cloneTokens(tok.previousTokens)));
      }
    }
    if (!historyTokens.length) {
      historyTokens.push(
        ...originalTokens.slice(card.rangeStart, card.rangeEnd + 1).filter((tok) => tok.kind !== "empty")
      );
    }
    const beforeIds = normalizeBeforeIds(historyTokens);
    const afterFragments = tokens
      .slice(card.rangeStart, card.rangeEnd + 1)
      .filter((tok) => tok.kind !== "empty")
      .map(fragmentFromToken);
    const beforeText = textForIds(beforeIds);
    const afterText = afterFragments.map((f) => f.text).join(" ").trim();
    let operation: AnnotationDetailPayload["operation"] = "replace";
    if (!afterFragments.length || afterText === "") {
      operation = "delete";
    } else if (!beforeIds.length) {
      operation = "insert";
    } else if (beforeText === afterText) {
      operation = "noop";
    }

    const replacement = afterFragments.length === 0 ? null : afterFragments.map((f) => f.text).join(" ").trim() || null;
    const beforeIndices = beforeIds
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
      before_tokens: beforeIds,
      after_tokens: afterFragments,
      source: "manual",
    };
    const draft: AnnotationDraft = {
      start_token: spanStart,
      end_token: spanEnd,
      replacement,
      error_type_id: typeId,
      payload,
    };
    const spanKey = `${spanStart}-${spanEnd}`;
    const existingId = annotationIdMap?.get(spanKey);
    if (existingId !== undefined) {
      draft.id = existingId;
    }
    payloads.push(draft);
  });

  if (includeDeletedIds && annotationIdMap) {
    const spanKeys = new Set(payloads.map((p) => `${p.start_token}-${p.end_token}`));
    const deletedIds = Array.from(annotationIdMap.entries())
      .filter(([span]) => !spanKeys.has(span))
      .map(([, id]) => id);
    (payloads as any).deleted_ids = deletedIds;
  }

  return payloads;
};
