import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { ErrorType, SaveStatus, TokenFragmentPayload } from "../types";
import { useCorrectionSelection } from "../hooks/useCorrectionSelection";
import { useCorrectionTypes } from "../hooks/useCorrectionTypes";
import { useEditorUIState } from "../hooks/useEditorUIState";
import { useSaveController } from "../hooks/useSaveController";
import {
  colorWithAlpha,
  getErrorTypeLabel,
  getErrorTypeSuperLabel,
} from "../utils/errorTypes";
import {
  EditorPresentState,
  HotkeySpec,
  MoveMarker,
  Token,
  buildAnnotationsPayloadStandalone,
  buildEditableTextFromTokens,
  buildHotkeyMap,
  buildTextFromTokensWithBreaks,
  cloneTokens,
  createId,
  dedupeTokens,
  deriveCorrectionByIndex,
  deriveCorrectionCards,
  deriveMoveMarkers,
  deriveOperationsFromTokens,
  makeEmptyPlaceholder,
  normalizeHotkeySpec,
  rangeToArray,
  tokenizeEditedText,
  tokenizeToTokens,
  tokenEditorReducer,
  unwindToOriginal,
} from "./TokenEditorModel";

export * from "./TokenEditorModel";

// ---------------------------
// Component
// ---------------------------

const PREFS_KEY = "tokenEditorPrefs";
const DEFAULT_TOKEN_GAP = 2;
const DEFAULT_TOKEN_FONT_SIZE = 24;
type SpaceMarker = "dot" | "box" | "none";


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
  word: { ...chipBase, color: "#e2e8f0", padding: "0px" },
  punct: {
    ...chipBase,
    color: "#e2e8f0",
    padding: 0,
    gap: 0,
    margin: 0,
    justifyContent: "center",
  },
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

const normalizeSpaceMarker = (value: unknown): SpaceMarker => {
  return value === "dot" || value === "box" || value === "none" ? value : "box";
};

const loadPrefs = (): {
  tokenGap?: number;
  tokenFontSize?: number;
  spaceMarker?: SpaceMarker;
  lastDecision?: "skip" | "trash" | "submit" | null;
  lastTextId?: number;
  viewTab?: "original" | "corrected";
  textPanelOpen?: boolean;
} => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (parsed.spaceMarker) {
        parsed.spaceMarker = normalizeSpaceMarker(parsed.spaceMarker);
      }
    }
    return parsed;
  } catch {
    return {};
  }
};

// Local token history is no longer persisted in production; in tests we still allow
// loading/saving from localStorage to keep legacy test fixtures working.
const loadEditorState = (textId: number): EditorPresentState | null => {
  if (process.env.NODE_ENV !== "test") return null;
  try {
    const raw = localStorage.getItem(`${PREFS_KEY}:state:${textId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.originalTokens || !parsed?.tokens) return null;
    return {
      originalTokens: parsed.originalTokens,
      tokens: parsed.tokens,
      operations: Array.isArray(parsed.operations) ? parsed.operations : [],
    } as EditorPresentState;
  } catch {
    return null;
  }
};

const persistEditorState = (textId: number, state: EditorPresentState) => {
  if (process.env.NODE_ENV !== "test") return;
  try {
    localStorage.setItem(`${PREFS_KEY}:state:${textId}`, JSON.stringify(state));
  } catch {
    // ignore
  }
};

export const TokenEditor: React.FC<{
  initialText: string;
  textId: number;
  categoryId: number;
  highlightAction?: "skip" | "trash" | "submit";
  currentUserId?: string | null;
  onSaveStatusChange?: (status: SaveStatus) => void;
}> = ({
  initialText,
  textId,
  categoryId,
  highlightAction,
  currentUserId,
  onSaveStatusChange,
}) => {
  const { t, locale } = useI18n();
  const { get, post } = useAuthedApi();
  const navigate = useNavigate();
  const location = useLocation();

  const [history, dispatch] = useReducer(tokenEditorReducer, {
    past: [],
    present: { originalTokens: [], tokens: [], operations: [] },
    future: [],
  });

  // Selection and editing UI state (kept outside history) is driven by a state machine.
  const {
    ui,
    setSelection,
    startEdit,
    updateEditText,
    endEdit,
    openClearConfirm,
    closeClearConfirm,
    openFlagConfirm,
    closeFlagConfirm,
    updateFlagReason,
    updateFlagError,
    resetUI,
  } = useEditorUIState();
  const selection = ui.selection;
  const editingRange = ui.editingRange;
  const editText = ui.editText;
  const pendingAction = ui.pendingAction;
  const flagReason = ui.flagReason;
  const flagError = ui.flagError;
  const showClearConfirm = ui.overlay === "clear";
  const prefs = useMemo(() => loadPrefs(), []);
  const [tokenGap, setTokenGap] = useState(Math.max(0, prefs.tokenGap ?? DEFAULT_TOKEN_GAP));
  const [tokenFontSize, setTokenFontSize] = useState(prefs.tokenFontSize ?? DEFAULT_TOKEN_FONT_SIZE);
  const [spaceMarker, setSpaceMarker] = useState<SpaceMarker>(normalizeSpaceMarker(prefs.spaceMarker));
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const tokenRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragStateRef = useRef<{ start: number; end: number } | null>(null);
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const measureTextWidth = useCallback(
    (text: string, size?: number) => {
      let canvas = measureCanvasRef.current;
      if (!canvas) {
        canvas = document.createElement("canvas");
        measureCanvasRef.current = canvas;
      }
      const ctx = canvas.getContext("2d");
      const fontSize = size ?? tokenFontSize;
      if (!ctx) return text.length * fontSize * 0.65;
      ctx.font = `${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
      return ctx.measureText(text || "").width;
    },
    [tokenFontSize]
  );
  const tokenRowRef = useRef<HTMLDivElement | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [hoveredMoveId, setHoveredMoveId] = useState<string | null>(null);
  const [moveLine, setMoveLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSkipping, setIsSkipping] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const initialViewTab = useMemo<"original" | "corrected">(() => {
    if (prefs.viewTab === "original" || prefs.viewTab === "corrected") {
      return prefs.viewTab;
    }
    return "corrected";
  }, [prefs.viewTab]);
  const [viewTab, setViewTab] = useState<"original" | "corrected">(initialViewTab);
  const [isTextPanelOpen, setIsTextPanelOpen] = useState<boolean>(prefs.textPanelOpen ?? true);
  const computeLineBreaks = useCallback((text: string) => {
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
  }, []);
  const [lineBreaks, setLineBreaks] = useState<number[]>(() => computeLineBreaks(initialText));
  const lineBreakSet = useMemo(() => new Set(lineBreaks), [lineBreaks]);
  const lineBreakCountMap = useMemo(() => {
    const map = new Map<number, number>();
    lineBreaks.forEach((idx) => {
      map.set(idx, (map.get(idx) ?? 0) + 1);
    });
    return map;
  }, [lineBreaks]);
  const lastSavedSignatureRef = useRef<string | null>(null);
  const [lastDecision, setLastDecision] = useState<"skip" | "trash" | "submit" | null>(
    prefs.lastTextId === textId ? prefs.lastDecision ?? null : null
  );
  const [errorTypes, setErrorTypes] = useState<ErrorType[]>([]);
  const [isLoadingErrorTypes, setIsLoadingErrorTypes] = useState(false);
  const [errorTypesError, setErrorTypesError] = useState<string | null>(null);
  const [serverAnnotationVersion, setServerAnnotationVersion] = useState(0);
  const annotationIdMap = useRef<Map<string, number>>(new Map());
  const pendingLocalStateRef = useRef<EditorPresentState | null>(null);
  const hydratedFromServerRef = useRef(false);
  const handleRevert = (rangeStart: number, rangeEnd: number) => {
    markSkipAutoSelect();
    setPendingSelectIndex(rangeStart);
    dispatch({ type: "REVERT_CORRECTION", rangeStart, rangeEnd });
    setSelection({ start: null, end: null });
    endEdit();
  };

  const tokens = history.present.tokens;
  const originalTokens = history.present.originalTokens;
  const lineStartIndices = useMemo(() => {
    if (!lineBreaks.length) return new Set<number>();
    const starts = new Set<number>();
    let visibleIndex = 0;
    tokens.forEach((tok, idx) => {
      if (tok.kind === "empty") return;
      if (lineBreakSet.has(visibleIndex)) {
        starts.add(idx);
      }
      visibleIndex += 1;
    });
    return starts;
  }, [tokens, lineBreaks, lineBreakSet]);
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
    (tok: Token): TokenFragmentPayload => {
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
    },
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

  // Derived helpers
  const hasSelection = selection.start !== null && selection.end !== null;
  const selectedIndices = useMemo(() => {
    if (!hasSelection) return [];
    const [s, e] = [selection.start!, selection.end!];
    const start = Math.min(s, e);
    const end = Math.max(s, e);
    return rangeToArray([start, end]);
  }, [hasSelection, selection]);

  // Init from text on mount.
  useEffect(() => {
    setServerAnnotationVersion(0);
    hydratedFromServerRef.current = false;
    resetUI();
  }, [resetUI, textId]);

  useEffect(() => {
    const saved = loadEditorState(textId);
    if (saved) {
      pendingLocalStateRef.current = saved;
      dispatch({ type: "INIT_FROM_STATE", state: saved });
    } else {
      pendingLocalStateRef.current = null;
      dispatch({ type: "INIT_FROM_TEXT", text: initialText });
    }
    lastSavedSignatureRef.current = null;
  }, [initialText, textId]);

  useEffect(() => {
    setLineBreaks(computeLineBreaks(initialText));
  }, [initialText, computeLineBreaks]);

  const hydrateFromServerAnnotations = useCallback(
    (items: any[]) => {
      if (!items?.length) return null;
      const baseTokens = tokenizeToTokens(initialText);
      let working = cloneTokens(baseTokens);
      let offset = 0;
      const typeMap: Record<string, number | null> = {};
      const spanMap = new Map<string, number>();
      const sorted = [...items].sort(
        (a, b) => (a?.start_token ?? 0) - (b?.start_token ?? 0) || (a?.end_token ?? 0) - (b?.end_token ?? 0)
      );
      sorted.forEach((ann: any) => {
        const payload = ann?.payload || {};
        const operation = payload.operation || (ann?.replacement ? "replace" : "noop");
        if (operation === "noop") return;
        if (String(operation) === "move") {
          const afterRaw = Array.isArray(payload.after_tokens) ? payload.after_tokens : [];
          const beforeTokensPayload = Array.isArray(payload.before_tokens) ? payload.before_tokens : [];
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
          const moveLen =
            typeof payload.move_len === "number"
              ? payload.move_len
              : afterRaw.length
                ? afterRaw.length
                : beforeTokensPayload.length
                  ? beforeTokensPayload.length
                  : 1;
          const sourceStart = Math.max(0, Math.min(working.length, moveFrom + offset));
          const sourceEnd = Math.max(sourceStart, Math.min(working.length - 1, sourceStart + moveLen - 1));
          const moveId = `move-${createId()}`;

          const originalById = new Map<string, Token>();
          baseTokens.forEach((tok) => {
            if (tok.kind === "empty") return;
            originalById.set(tok.id, tok);
          });
          const mappedHistory = beforeTokensPayload
            .map((id: string) => originalById.get(id))
            .filter(Boolean)
            .map((tok) => ({ ...tok!, selected: false, previousTokens: undefined }));
          const historyTokens = mappedHistory.length
            ? mappedHistory
            : dedupeTokens(unwindToOriginal(cloneTokens(working.slice(sourceStart, sourceEnd + 1))));
          const placeholder = {
            ...makeEmptyPlaceholder(historyTokens),
            groupId: `move-src-${moveId}`,
            moveId,
            spaceBefore: working[sourceStart]?.spaceBefore ?? true,
          };

          const buildTokensFromFragments = (
            fragments: any[],
            fallbackText: string,
            defaultFirstSpace?: boolean
          ): Token[] => {
            const built: Token[] = [];
            const hasFragments = fragments.length > 0;
            const baseFragments = hasFragments ? fragments : fallbackText ? [{ text: fallbackText }] : [];
            baseFragments.forEach((frag: any, fragIndex: number) => {
              const text = typeof frag?.text === "string" ? frag.text : "";
              if (!text) return;
              const origin = frag?.origin === "inserted" ? "inserted" : undefined;
              const explicitSpace =
                typeof frag?.space_before === "boolean"
                  ? frag.space_before
                  : typeof frag?.spaceBefore === "boolean"
                    ? frag.spaceBefore
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

          const rawMovedTokens = afterRaw.length
            ? buildTokensFromFragments(afterRaw, "", undefined)
            : cloneTokens(working.slice(sourceStart, sourceEnd + 1));

          working.splice(sourceStart, sourceEnd - sourceStart + 1);
          working.splice(sourceStart, 0, placeholder);

          let insertionIndex = Math.max(0, Math.min(working.length, moveTo + offset));
          if (insertionIndex > sourceEnd + 1) {
            insertionIndex -= sourceEnd - sourceStart + 1;
          }
          if (insertionIndex >= sourceStart) {
            insertionIndex += 1;
          }
          insertionIndex = Math.max(0, Math.min(working.length, insertionIndex));
          const leadingSpace = insertionIndex === 0 ? false : working[insertionIndex]?.spaceBefore !== false;

          const movedTokens = rawMovedTokens.map((tok, idx) => ({
            ...tok,
            id: createId(),
            groupId: `move-dest-${moveId}`,
            moveId,
            spaceBefore: idx === 0 ? leadingSpace : tok.spaceBefore,
            previousTokens: tok.previousTokens ? cloneTokens(tok.previousTokens) : tok.previousTokens,
          }));

          working.splice(insertionIndex, 0, ...movedTokens);
          typeMap[moveId] = ann?.error_type_id ?? null;
          const spanStart = moveTo;
          const spanEnd = moveTo + Math.max(1, movedTokens.length) - 1;
          if (currentUserId && ann?.author_id === currentUserId && ann?.id != null) {
            const spanKey = `${spanStart}-${spanEnd}`;
            spanMap.set(spanKey, ann.id);
          }
          offset += 1;
          return;
        }
        const startOriginal = typeof ann?.start_token === "number" ? ann.start_token : 0;
        const endOriginal = typeof ann?.end_token === "number" ? ann.end_token : startOriginal;
        const targetStart = Math.max(0, Math.min(working.length, startOriginal + offset));
        const leadingSpace = targetStart === 0 ? false : working[targetStart]?.spaceBefore !== false;
        const beforeTokensPayload = Array.isArray(payload.before_tokens) ? payload.before_tokens : [];
        const removeCountFromSpan =
          operation === "insert"
            ? 0
            : Math.max(0, Math.min(working.length - targetStart, Math.max(0, endOriginal - startOriginal + 1)));
        const beforeCount = beforeTokensPayload.length
          ? Math.min(working.length - targetStart, beforeTokensPayload.length)
          : 0;
        const removeCount = beforeCount > 0 ? beforeCount : removeCountFromSpan;
        const previousRaw = cloneTokens(working.slice(targetStart, targetStart + removeCount));
        const previous =
          operation === "insert" && previousRaw.length === 0 ? [makeEmptyPlaceholder([])] : previousRaw;
        const afterRaw = Array.isArray(payload.after_tokens) ? payload.after_tokens : [];
        const replacementText = ann?.replacement ? String(ann.replacement) : "";
      const buildTokensFromFragments = (
        fragments: any[],
        fallbackText: string,
        defaultFirstSpace?: boolean
      ): Token[] => {
        const built: Token[] = [];
        const hasFragments = fragments.length > 0;
        const baseFragments = hasFragments ? fragments : fallbackText ? [{ text: fallbackText }] : [];
        baseFragments.forEach((frag: any, fragIndex: number) => {
          const text = typeof frag?.text === "string" ? frag.text : "";
          if (!text) return;
          const origin = frag?.origin === "inserted" ? "inserted" : undefined;
          const explicitSpace =
            typeof frag?.space_before === "boolean"
              ? frag.space_before
              : typeof frag?.spaceBefore === "boolean"
                ? frag.spaceBefore
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
        const groupId = createId();
        const cardType = ann?.error_type_id ?? null;

        const newTokens: Token[] = [];
        const builtTokens = buildTokensFromFragments(afterRaw, replacementText, leadingSpace);
        if (!builtTokens.length && (operation === "delete" || operation === "insert")) {
          newTokens.push({ ...makeEmptyPlaceholder(previous), groupId, spaceBefore: leadingSpace });
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
          newTokens[0].spaceBefore = leadingSpace;
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
          const spanKey = `${ann.start_token}-${ann.end_token}`;
          spanMap.set(spanKey, ann.id);
        }
        offset += newTokens.length - removal;
      });
      const operations = deriveOperationsFromTokens(baseTokens, working);
      const present: EditorPresentState = {
        originalTokens: cloneTokens(baseTokens),
        tokens: working,
        operations,
      };
      return { present, typeMap, spanMap };
    },
    [initialText, currentUserId]
  );

  useEffect(() => {
    try {
      localStorage.setItem("lastAnnotationPath", location.pathname);
    } catch {
      // ignore
    }
  }, [location.pathname]);

  // Update selection highlight by toggling selected flag (not stored in history).
  const selectedSet = useMemo(() => new Set(selectedIndices), [selectedIndices]);
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

  const moveMarkers = useMemo(() => deriveMoveMarkers(tokens), [tokens]);
  const moveMarkerById = useMemo(() => {
    const map = new Map<string, MoveMarker>();
    moveMarkers.forEach((marker) => map.set(marker.id, marker));
    return map;
  }, [moveMarkers]);
  const moveIndexToId = useMemo(() => {
    const map = new Map<number, string>();
    moveMarkers.forEach((marker) => {
      for (let i = marker.fromStart; i <= marker.fromEnd; i += 1) {
        map.set(i, marker.id);
      }
      for (let i = marker.toStart; i <= marker.toEnd; i += 1) {
        map.set(i, marker.id);
      }
    });
    return map;
  }, [moveMarkers]);

  useEffect(() => {
    if (!hoveredMoveId) {
      setMoveLine(null);
      return;
    }
    const marker = moveMarkerById.get(hoveredMoveId);
    if (!marker || !tokenRowRef.current) {
      setMoveLine(null);
      return;
    }
    const sourceKey = `range:${marker.fromStart}-${marker.fromEnd}`;
    const destKey = `range:${marker.toStart}-${marker.toEnd}`;
    const sourceEl = groupRefs.current[sourceKey];
    const destEl = groupRefs.current[destKey];
    if (!sourceEl || !destEl) {
      setMoveLine(null);
      return;
    }
    const containerRect = tokenRowRef.current.getBoundingClientRect();
    const srcRect = sourceEl.getBoundingClientRect();
    const dstRect = destEl.getBoundingClientRect();
    const rightward = dstRect.left >= srcRect.right;
    const x1 = rightward ? srcRect.right - containerRect.left : srcRect.left - containerRect.left;
    const x2 = rightward ? dstRect.left - containerRect.left : dstRect.right - containerRect.left;
    const y1 = srcRect.top + srcRect.height / 2 - containerRect.top;
    const y2 = dstRect.top + dstRect.height / 2 - containerRect.top;
    setMoveLine({ x1, y1, x2, y2 });
  }, [hoveredMoveId, moveMarkerById]);
  const correctionCards = useMemo(
    () => deriveCorrectionCards(tokens, moveMarkers),
    [tokens, moveMarkers]
  );

  const correctionByIndex = useMemo(
    () => deriveCorrectionByIndex(correctionCards, moveMarkers),
    [correctionCards, moveMarkers]
  );
  const {
    activeErrorTypeId,
    setActiveErrorTypeId,
    correctionTypeMap,
    applyTypeToCorrections,
    seedCorrectionTypes,
  } = useCorrectionTypes({ textId, correctionCards });

  const { markSkipAutoSelect, setPendingSelectIndex } = useCorrectionSelection({
    correctionCards,
    tokens,
    setSelection,
  });

  useEffect(() => {
    let cancelled = false;
    const loadExistingAnnotations = async () => {
      try {
        const res = await get(`/api/texts/${textId}/annotations`, { params: { all_authors: true } });
        if (cancelled) return;
        const items = Array.isArray(res.data) ? res.data : [];
        const maxVersion = items.reduce((acc: number, ann: any) => Math.max(acc, ann?.version ?? 0), 0);
        setServerAnnotationVersion(maxVersion);
        const hydrated = hydrateFromServerAnnotations(items);
        if (hydrated && !hydratedFromServerRef.current) {
          dispatch({ type: "INIT_FROM_STATE", state: hydrated.present });
          seedCorrectionTypes(hydrated.typeMap);
          annotationIdMap.current = hydrated.spanMap;
          hydratedFromServerRef.current = true;
        } else if (!hydratedFromServerRef.current && pendingLocalStateRef.current) {
          dispatch({ type: "INIT_FROM_STATE", state: pendingLocalStateRef.current });
          hydratedFromServerRef.current = true;
        } else {
          annotationIdMap.current = new Map<string, number>();
          items.forEach((ann: any) => {
            if (
              ann?.id != null &&
              typeof ann.start_token === "number" &&
              typeof ann.end_token === "number" &&
              (!currentUserId || ann.author_id === currentUserId)
            ) {
              const key = `${ann.start_token}-${ann.end_token}`;
              annotationIdMap.current.set(key, ann.id);
            }
          });
        }
        if (!items.length) {
          annotationIdMap.current = new Map<string, number>();
        }
      } catch {
        // ignore load errors; optimistic saves will still work
      }
    };
    loadExistingAnnotations();
    return () => {
      cancelled = true;
    };
  }, [get, textId, hydrateFromServerAnnotations, currentUserId, seedCorrectionTypes]);

  const requestNextText = useCallback(async () => {
    try {
      const response = await post("/api/texts/assignments/next", null, {
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
          const categories = await get("/api/categories/");
          const current = (categories.data as Array<{ id: number; remaining_texts: number }>).find(
            (c) => c.id === categoryId,
          );
          if (current && current.remaining_texts > 0) {
            setActionMessage(t("categories.noTextsAvailableNow") ?? "No texts available right now. Please try again.");
            return false;
          } else {
            navigate("/");
            return true;
          }
        } catch {
          setActionMessage(t("categories.noTextsAvailableNow") ?? "No texts available right now. Please try again.");
          return false;
        }
      } else {
        setActionError(formatError(error));
      }
    }
    return false;
  }, [get, post, categoryId, navigate, t, textId]);

  useEffect(() => {
    let cancelled = false;
    const loadErrorTypes = async () => {
      setIsLoadingErrorTypes(true);
      setErrorTypesError(null);
      try {
        const response = await get("/api/error-types/");
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
  }, [get, formatError]);

  const handleFlag = useCallback((flagType: "skip" | "trash") => {
    setActionError(null);
    setActionMessage(null);
    openFlagConfirm(flagType);
  }, [openFlagConfirm]);

  const confirmFlag = useCallback(async () => {
    if (!pendingAction) return;
    const flagType = pendingAction;
    setActionError(null);
    setActionMessage(null);
    updateFlagError(null);
    flagType === "skip" ? setIsSkipping(true) : setIsTrashing(true);
    let succeeded = false;
    try {
      const reason = flagReason.trim();
      await post(`/api/texts/${textId}/${flagType}`, { reason: reason || undefined });
      setLastDecision(flagType);
      await requestNextText();
      succeeded = true;
    } catch (error: any) {
      updateFlagError(formatError(error));
    } finally {
      flagType === "skip" ? setIsSkipping(false) : setIsTrashing(false);
      if (succeeded) {
        closeFlagConfirm();
      }
    }
  }, [post, flagReason, pendingAction, requestNextText, textId, updateFlagError, closeFlagConfirm]);

  const cancelFlag = useCallback(() => {
    closeFlagConfirm();
  }, [closeFlagConfirm]);

  // Enter edit mode from selection.
  const beginEdit = (range?: { start: number; end: number }, caretIndex?: number) => {
    const activeRange = range ?? (hasSelection ? { start: Math.min(selection.start!, selection.end!), end: Math.max(selection.start!, selection.end!) } : null);
    if (!activeRange) return;
    const slice = tokens.slice(activeRange.start, activeRange.end + 1);
    // Do not allow editing if any ⬚ token is in the selection.
    if (slice.some((tok) => tok.kind === "empty" || tok.kind === "special")) {
      return;
    }
    const editValue = buildEditableTextFromTokens(slice);
    startEdit(activeRange, editValue);
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
    setPendingSelectIndex(start!);
    dispatch({ type: "EDIT_SELECTED_RANGE_AS_TEXT", range: [start!, end!], newText: editText });
    endEdit();
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
    endEdit();
  };

  const expandRangeToGroups = useCallback(
    (start: number, end: number) => {
      let s = Math.min(start, end);
      let e = Math.max(start, end);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (let i = s; i <= e; i += 1) {
          const tok = tokens[i];
          if (!tok?.groupId) continue;
          let l = i;
          let r = i;
          while (l - 1 >= 0 && tokens[l - 1]?.groupId === tok.groupId) l -= 1;
          while (r + 1 < tokens.length && tokens[r + 1]?.groupId === tok.groupId) r += 1;
          if (l < s || r > e) {
            s = Math.min(s, l);
            e = Math.max(e, r);
            expanded = true;
            break;
          }
        }
      }
      return { start: s, end: e };
    },
    [tokens]
  );

  const handleDragStart = useCallback(
    (index: number, event: React.DragEvent<HTMLDivElement>) => {
      if (editingRange) {
        event.preventDefault();
        return;
      }
      const token = tokens[index];
      if (!token || token.kind === "empty") {
        event.preventDefault();
        return;
      }
      let range: { start: number; end: number };
      if (hasSelection && index >= Math.min(selection.start!, selection.end!) && index <= Math.max(selection.start!, selection.end!)) {
        range = expandRangeToGroups(Math.min(selection.start!, selection.end!), Math.max(selection.start!, selection.end!));
      } else {
        range = expandRangeToGroups(index, index);
        setSelection(range);
      }
      const slice = tokens.slice(range.start, range.end + 1);
      if (!slice.length || slice.some((tok) => tok.kind === "empty")) {
        event.preventDefault();
        return;
      }
      dragStateRef.current = range;
      setDropIndex(null);
      event.dataTransfer.setData("text/plain", "move");
      event.dataTransfer.effectAllowed = "move";
      const preview = document.createElement("div");
      preview.textContent = slice.map((t) => t.text).join(" ");
      preview.style.position = "absolute";
      preview.style.top = "-9999px";
      preview.style.left = "-9999px";
      preview.style.padding = "6px 10px";
      preview.style.background = "rgba(30,41,59,0.9)";
      preview.style.color = "#e2e8f0";
      preview.style.border = "1px solid rgba(148,163,184,0.6)";
      preview.style.borderRadius = "10px";
      document.body.appendChild(preview);
      event.dataTransfer.setDragImage(preview, 10, 10);
      setTimeout(() => {
        document.body.removeChild(preview);
      }, 0);
    },
    [editingRange, expandRangeToGroups, hasSelection, selection, setSelection, tokens]
  );

  const handleDragOverToken = useCallback(
    (index: number, event: React.DragEvent<HTMLDivElement>) => {
      if (!dragStateRef.current) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const isAfter = (event.clientX - rect.left) / Math.max(1, rect.width) > 0.5;
      const nextIndex = isAfter ? index + 1 : index;
      setDropIndex(nextIndex);
    },
    []
  );

  const handleDragOverGap = useCallback((index: number, event: React.DragEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return;
    event.preventDefault();
    setDropIndex(index);
  }, []);

  const handleDropAt = useCallback(
    (index: number) => {
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      setDropIndex(null);
      if (!drag) return;
      dispatch({ type: "MOVE_SELECTED_TOKENS", fromStart: drag.start, fromEnd: drag.end, toIndex: index });
      setSelection({ start: null, end: null });
    },
    [setSelection]
  );

  const handleDragEnd = useCallback(() => {
    dragStateRef.current = null;
    setDropIndex(null);
  }, []);

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

  const performUndo = () => {
    if (editingRange) {
      cancelEdit();
    }
    markSkipAutoSelect();
    setSelection({ start: null, end: null });
    dispatch({ type: "UNDO" });
  };

  const performRedo = () => {
    if (editingRange) {
      cancelEdit();
    }
    markSkipAutoSelect();
    setSelection({ start: null, end: null });
    dispatch({ type: "REDO" });
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || (target as HTMLInputElement).isContentEditable);
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const key = event.key?.toLowerCase();
      const code = event.code?.toLowerCase();
      const isKeyZ = key === "z" || code === "keyz";
      const isKeyY = key === "y" || code === "keyy";
      const isUndoKey = ctrlOrMeta && isKeyZ && !event.shiftKey;
      const isRedoKey = ctrlOrMeta && (isKeyY || (event.shiftKey && isKeyZ));
      if (isUndoKey || isRedoKey) {
        event.preventDefault();
        if (isUndoKey) {
          performUndo();
        } else {
          performRedo();
        }
        return;
      }
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
        closeClearConfirm();
        return;
      }
      if (pendingAction && event.key === "Escape") {
        event.preventDefault();
        cancelFlag();
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
        startEdit({ start: newIndex, end: newIndex }, "");
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
  }, [editingRange, hasSelection, selection, showClearConfirm, pendingAction, cancelFlag, closeClearConfirm]);

  const renderToken = (token: Token, index: number, forceChanged = false) => {
    const isSelected = selectedSet.has(index);
    const isMovePlaceholder = Boolean(token.moveId && token.kind === "empty");
    const hasHistory = forceChanged || (Boolean(token.previousTokens?.length) && !isMovePlaceholder);
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
      cursor: isSpecial ? "default" : "pointer",
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
        cursor: "pointer",
      });
    }
    if (isSelected) {
      Object.assign(
        style,
        chipStyles.selected,
        isEmpty
          ? {
              background: "rgba(14,165,233,0.25)",
              borderStyle: "solid",
              color: "#e2e8f0",
            }
          : {}
      );
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
      // Match the editing pill to the text length with only minimal breathing room.
      const editPxWidth = Math.max(8, measuredPx + tokenFontSize * 0.6);
      const selectedHighlight = chipStyles.selected;
      const editHeight = Math.max(24, tokenFontSize * 1.2);
      return (
        <div
          key={`edit-${index}`}
          style={{
            ...style,
            ...selectedHighlight,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(59,130,246,0.12)",
            width: `${editPxWidth}px`,
            minWidth: `${editPxWidth}px`,
            maxWidth: `${editPxWidth}px`,
            height: editHeight,
            padding: "2px 6px",
            borderRadius: 10,
            border: "1px solid rgba(148,163,184,0.25)",
            flex: "0 0 auto",
            boxSizing: "border-box",
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
              fontSize: tokenFontSize,
              lineHeight: 1.05,
              padding: 0,
              margin: 0,
            }}
            value={editText}
            onChange={(e) => updateEditText(e.target.value)}
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
      );
    }
    return (
      <div
        key={token.id}
        style={style}
        data-token-index={index}
        draggable={!isSpecial && !isEmpty}
        onDragStart={(e) => {
          if (isSpecial || isEmpty) {
            e.preventDefault();
            return;
          }
          handleDragStart(index, e);
        }}
        onDragOver={(e) => handleDragOverToken(index, e)}
        onDrop={(e) => {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          const isAfter = (e.clientX - rect.left) / Math.max(1, rect.width) > 0.5;
          const targetIndex = isAfter ? index + 1 : index;
          handleDropAt(targetIndex);
        }}
        onDragEnd={handleDragEnd}
        onClick={(e) => {
          if (isSpecial) return;
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
        role="button"
        tabIndex={isSpecial ? -1 : 0}
        ref={(el) => {
          tokenRefs.current[token.id] = el;
        }}
        aria-pressed={isSelected}
      >
        <span>{displayText}</span>
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

    const renderGap = (idx: number) => {
      const base = Math.max(0, tokenGap);
      const nextTok = tokens[idx];
      const isLineStart = lineStartIndices.has(idx);
      const hasSpace = !isLineStart && nextTok?.spaceBefore !== false;
      const isPunctAdjacent = nextTok?.kind === "punct";
      const isEdge = idx === 0 || idx >= tokens.length || isLineStart;
      const baseWidth = isEdge ? 0 : hasSpace ? base : Math.max(0, Math.floor(base * (isPunctAdjacent ? 0.2 : 0.25)));
      const minSpaceWidth = Math.max(2, tokenFontSize * 0.16);
      const gapWidth = hasSpace && !isEdge ? Math.max(baseWidth, minSpaceWidth) : baseWidth;
      const markerChar: string | null =
        !hasSpace || isEdge
          ? null
          : spaceMarker === "dot"
            ? "·"
            : spaceMarker === "box"
              ? "␣"
              : null;
      const markerShift = Math.max(0, tokenFontSize * 0.05);
      const markerStyle: React.CSSProperties = {
        fontSize: Math.max(8, tokenFontSize * 0.45),
        color: "rgba(148,163,184,0.6)",
        lineHeight: 1,
        transform: `translateY(${markerShift}px)`,
        pointerEvents: "none",
        userSelect: "none",
      };
      return (
        <div
          key={`gap-${idx}`}
          data-drop-index={idx}
          style={{
            width: gapWidth,
            height: Math.max(28, tokenFontSize * 1.2),
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            position: "relative",
          }}
          onDragOver={(e) => handleDragOverGap(idx, e)}
          onDrop={(e) => {
            e.preventDefault();
            handleDropAt(idx);
          }}
        >
          {dropIndex === idx && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: "50%",
                top: -6,
                bottom: -6,
                width: 2,
                background: "rgba(94,234,212,0.85)",
                boxShadow: "0 0 0 1px rgba(94,234,212,0.5)",
                transform: "translateX(-50%)",
              }}
            />
          )}
          {markerChar && (
            <span
              aria-hidden="true"
              data-testid="space-marker"
              style={markerStyle}
            >
              {markerChar}
            </span>
          )}
        </div>
      );
    };

    const result: React.ReactNode[] = [renderGap(0)];

    groups.forEach((group, groupIndex) => {
      const hasHistory = group.tokens.some((t) => t.previousTokens?.length);
      const anchorToken =
        group.tokens.find((t) => t.previousTokens?.length) ?? group.tokens[Math.floor(group.tokens.length / 2)];
      const historyTokens = anchorToken.previousTokens ?? [];
      const moveId = moveIndexToId.get(group.start) ?? moveIndexToId.get(group.end);
      const moveMarker = moveId ? moveMarkerById.get(moveId) ?? null : null;
      const isMoveGroup = Boolean(moveId);
      const isMoveDestination = Boolean(
        moveMarker && group.start >= moveMarker.toStart && group.end <= moveMarker.toEnd
      );
      const cardId = moveId ?? correctionByIndex.get(group.start) ?? correctionByIndex.get(group.end);
      const typeId = cardId ? correctionTypeMap[cardId] ?? null : null;
      const typeObj = typeId ? errorTypeById.get(typeId) ?? null : null;
      const badgeText = typeObj ? getErrorTypeLabel(typeObj, locale) : "";
      const badgeColor = typeObj?.default_color ?? "#94a3b8";
      const badgeFontSize = Math.max(8, tokenFontSize * 0.45);
      const badgePaddingY = Math.max(0.5, tokenFontSize * 0.07);
      const badgePaddingX = Math.max(2, tokenFontSize * 0.18);
      const badgeRadius = Math.max(6, tokenFontSize * 0.45);
      const badgeMaxWidth = Math.max(160, tokenFontSize * 12);
      const badgeTextWidth = badgeText ? measureTextWidth(badgeText, badgeFontSize) : 0;
      const badgeWidth = badgeText
        ? Math.min(badgeMaxWidth, badgeTextWidth + badgePaddingX * 2 + 10)
        : 0;
      const isPurePunctGroup = group.tokens.every((t) => t.kind === "punct");
      // Update visible counter for line breaks (count only rendered tokens).
      group.tokens.forEach((tok) => {
        if (tok.kind !== "empty") visibleCount += 1;
      });
      const showBorder = hasHistory || isMoveGroup;
      const showHistoryTokens = hasHistory && !isMoveGroup;
      const isMoveHover = Boolean(moveId && hoveredMoveId === moveId);

      const groupPadY = 0;
      const groupPadX = isPurePunctGroup ? 0 : 1;
      const paddingTop = Math.max(groupPadY, tokenFontSize * 0.12);
      const minSpaceWidth = Math.max(2, tokenFontSize * 0.16);
      const innerGap = Math.max(Math.max(0, tokenGap), minSpaceWidth);
      const verticalGap = Math.max(0, tokenFontSize * 0.02);
      const displayTextForToken = (tok: Token) => {
        if (tok.kind === "empty") return "⬚";
        if (tok.kind === "special" && tok.text.length > 32) {
          return `${tok.text.slice(0, 18)}…${tok.text.slice(-10)}`;
        }
        return tok.text;
      };
      const correctedWidth = group.tokens.reduce((acc, tok, i) => {
        const display = displayTextForToken(tok);
        const tokenWidth = Math.max(measureTextWidth(display), tokenFontSize * 0.6);
        const gapWidth = i === 0 ? 0 : innerGap;
        return acc + tokenWidth + gapWidth;
      }, 0);
      const historyWidth = historyTokens.reduce((acc, prev, i) => {
        const width = Math.max(measureTextWidth(prev.text, badgeFontSize), badgeFontSize * 0.8);
        return acc + width + (i ? 6 : 0);
      }, 0);
      const baseContentWidth = Math.max(correctedWidth, historyWidth, badgeWidth);
      const minWidth =
        isPurePunctGroup && !hasHistory && !typeObj
          ? Math.max(badgeWidth, baseContentWidth, tokenFontSize * 0.7 * group.tokens.length) + groupPadX * 2
          : Math.max(24 + groupPadX * 2, baseContentWidth + groupPadX * 2);

      const groupKey = `range:${group.start}-${group.end}`;
      const groupNode = (
        <div
          key={`group-${groupIndex}-${group.tokens[0].id}`}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: verticalGap,
            padding: `${paddingTop}px ${groupPadX}px ${groupPadY}px ${groupPadX}px`,
            borderRadius: 14,
            border: showBorder
              ? isMoveHover
                ? "1px solid rgba(94,234,212,0.85)"
                : "1px solid rgba(148,163,184,0.35)"
              : "1px solid transparent",
            background: "transparent",
            boxShadow: showBorder
              ? isMoveHover
                ? "0 0 0 1px rgba(94,234,212,0.5)"
                : "0 0 0 1px rgba(148,163,184,0.25)"
              : "none",
            flex: "0 0 auto",
            minWidth,
            position: "relative",
          }}
          ref={(el) => {
            groupRefs.current[groupKey] = el;
          }}
          onMouseEnter={() => {
            if (moveId) setHoveredMoveId(moveId);
          }}
          onMouseLeave={() => {
            if (moveId) setHoveredMoveId((prev) => (prev === moveId ? null : prev));
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 0,
              flexWrap: "wrap",
              justifyContent: "flex-start",
              alignItems: "center",
              marginBottom: Math.max(0, tokenFontSize * 0.03),
            }}
          >
            {hasHistory && !isMoveGroup && (
              <button
                style={groupUndoButtonStyle}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRevert(group.start, group.end);
                  setSelection({ start: null, end: null });
                  endEdit();
                }}
                title={t("tokenEditor.undo")}
              >
                ↺
              </button>
            )}
            {group.tokens.map((tok, i) => {
              const nodes: React.ReactNode[] = [];
              if (i > 0) {
                const isPunctAdjacent = tok.kind === "punct";
                const hasSpace = tok.spaceBefore !== false;
                const baseWidth = hasSpace ? innerGap : Math.max(0, Math.floor(innerGap * (isPunctAdjacent ? 0.2 : 0.25)));
                const gapWidth = hasSpace ? Math.max(baseWidth, minSpaceWidth) : baseWidth;
                const markerChar: string | null =
                  !hasSpace
                    ? null
                    : spaceMarker === "dot"
                      ? "·"
                      : spaceMarker === "box"
                        ? "␣"
                        : null;
                const markerShift = Math.max(0, tokenFontSize * 0.05);
                const markerStyle: React.CSSProperties = {
                  fontSize: Math.max(8, tokenFontSize * 0.45),
                  color: "rgba(148,163,184,0.6)",
                  lineHeight: 1,
                  transform: `translateY(${markerShift}px)`,
                  pointerEvents: "none",
                  userSelect: "none",
                };
                nodes.push(
                  <div
                    key={`inner-gap-${group.start + i}`}
                    data-drop-index={group.start + i}
                    style={{
                      width: gapWidth,
                      height: Math.max(28, tokenFontSize * 1.2),
                      display: "flex",
                      alignItems: "flex-end",
                      justifyContent: "center",
                      flex: "0 0 auto",
                      position: "relative",
                    }}
                    onDragOver={(e) => handleDragOverGap(group.start + i, e)}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleDropAt(group.start + i);
                    }}
                  >
                    {dropIndex === group.start + i && (
                      <span
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          left: "50%",
                          top: -6,
                          bottom: -6,
                          width: 2,
                          background: "rgba(94,234,212,0.85)",
                          boxShadow: "0 0 0 1px rgba(94,234,212,0.5)",
                          transform: "translateX(-50%)",
                        }}
                      />
                    )}
                    {markerChar && (
                      <span
                        aria-hidden="true"
                        data-testid="space-marker"
                        style={markerStyle}
                      >
                        {markerChar}
                      </span>
                    )}
                  </div>
                );
              }
              nodes.push(renderToken(tok, group.start + i, isMoveDestination));
              return nodes;
            })}
          </div>
          {showHistoryTokens && historyTokens.length > 0 && (
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                justifyContent: "center",
                textAlign: "center",
                marginBottom: 0,
              }}
            >
              {historyTokens.map((prev) => (
                <span
                  key={`${groupIndex}-prev-${prev.id}`}
                  style={{
                    ...chipStyles.previous,
                    fontSize: Math.max(8, tokenFontSize * 0.6),
                    padding: `${Math.max(0, tokenFontSize * 0.08)}px ${Math.max(1, tokenFontSize * 0.2)}px`,
                  }}
                >
                  {prev.text}
                </span>
              ))}
            </div>
          )}
          {typeObj && (
            <div
              style={{
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
                maxWidth: Math.max(48, minWidth - groupPadX * 2),
                overflow: "hidden",
                textOverflow: "ellipsis",
                alignSelf: "center",
                marginTop: 0,
              }}
              title={getErrorTypeLabel(typeObj, locale)}
            >
              {getErrorTypeLabel(typeObj, locale)}
            </div>
          )}
        </div>
      );
      result.push(groupNode);
      const lineBreakHeight = Math.max(4, Math.round(tokenFontSize * 0.2));
      const breakCount = lineBreakCountMap.get(visibleCount) ?? 0;
      if (breakCount > 0) {
        for (let i = 0; i < breakCount; i += 1) {
          result.push(
            <div
              key={`br-${visibleCount}-${i}`}
              data-testid="line-break"
              style={{
                width: "100%",
                height: lineBreakHeight,
                flexBasis: "100%",
                flexShrink: 0,
                flexGrow: 0,
              }}
            />
          );
        }
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

  const buildAnnotationsPayload = useCallback(
    () =>
      buildAnnotationsPayloadStandalone({
        initialText,
        tokens,
        originalTokens,
        correctionCards,
        correctionTypeMap,
        moveMarkers,
        annotationIdMap: annotationIdMap.current,
      }),
    [annotationIdMap, correctionCards, correctionTypeMap, initialText, moveMarkers, originalTokens, tokens]
  );

  const { saveAnnotations } = useSaveController({
    tokens: history.present.tokens,
    buildAnnotationsPayload,
    post,
    textId,
    serverAnnotationVersion,
    setServerAnnotationVersion,
    annotationIdMap,
    lastSavedSignatureRef,
    formatError,
    setActionError,
    onSaveStatusChange,
    statusTrigger: lastDecision,
  });

  useEffect(() => {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        tokenGap,
        tokenFontSize,
        spaceMarker,
        lastDecision,
        lastTextId: textId,
        viewTab,
        textPanelOpen: isTextPanelOpen,
      }),
    );
  }, [tokenGap, tokenFontSize, spaceMarker, lastDecision, textId, viewTab, isTextPanelOpen]);

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
      await post(`/api/texts/${textId}/submit`);
      setLastDecision("submit");
      await requestNextText();
    } catch (error: any) {
      setActionError(formatError(error));
    } finally {
      setIsSubmitting(false);
    }
  };
  const hasCorrections = correctionCards.length > 0;

  const hasSelectionTokens = hasSelection;

  const handleOpenSettings = () => {
    try {
      // no local persistence; rely on server hydration on reload
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
      applyTypeToCorrections(affectedIds, typeId);
    },
    [applyTypeToCorrections, correctionByIndex, selectedIndices]
  );

  const handleTypePick = useCallback(
    (typeId: number) => {
      setActiveErrorTypeId((prev) => (prev === typeId ? null : typeId));
      applyTypeToSelection(typeId);
    },
    [applyTypeToSelection, setActiveErrorTypeId]
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
      handleTypePick(typeId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hotkeyMap, eventToHotkeyStrings, handleTypePick]);

  const hasUnassignedCorrections = useMemo(
    () => correctionCards.some((card) => !correctionTypeMap[card.id]),
    [correctionCards, correctionTypeMap]
  );

  return (
    <div style={pageStyle}>
      <div style={twoColumnLayoutStyle}>
        <div style={mainColumnStyle}>
          {/* Token workspace */}
          <div style={workspaceStyle}>
            <div style={actionBarStyle}>
              <div style={toolbarRowStyle}>
                {toolbarButton(t("tokenEditor.undo"), performUndo, history.past.length === 0, "Ctrl+Z", "↺")}
                {toolbarButton(t("tokenEditor.redo"), performRedo, history.future.length === 0, "Ctrl+Y", "↻")}
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
                  startEdit({ start, end: start }, "");
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
                  startEdit({ start: newIndex, end: newIndex }, "");
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
                <div style={actionGroupStyle}>
                  <button
                    style={{
                      ...secondaryActionStyle,
                      opacity: !hasCorrections || isSubmitting ? 0.6 : 1,
                      cursor: !hasCorrections || isSubmitting ? "not-allowed" : "pointer",
                    }}
                    onClick={() => {
                      if (!hasCorrections) return;
                      openClearConfirm();
                    }}
                    disabled={!hasCorrections || isSubmitting || isSkipping || isTrashing}
                  >
                    {t("tokenEditor.clearAll")}
                  </button>
                  <button
                    style={{
                      ...secondaryActionStyle,
                      ...((highlightAction ?? lastDecision) === "skip" ? { boxShadow: "0 0 0 2px rgba(139,92,246,0.5)", borderColor: "#a78bfa" } : {}),
                      opacity: isSkipping ? 0.6 : 1,
                      cursor: isSkipping ? "not-allowed" : "pointer",
                    }}
                    onClick={() => handleFlag("skip")}
                    disabled={isSubmitting || isSkipping || isTrashing}
                  >
                    {t("annotation.skipText")}
                  </button>
                  <button
                    style={{
                      ...dangerActionStyle,
                      ...((highlightAction ?? lastDecision) === "trash" ? { boxShadow: "0 0 0 2px rgba(248,113,113,0.5)", borderColor: "#fb7185" } : {}),
                      opacity: isTrashing ? 0.6 : 1,
                      cursor: isTrashing ? "not-allowed" : "pointer",
                    }}
                    onClick={() => handleFlag("trash")}
                    disabled={isSubmitting || isSkipping || isTrashing}
                  >
                    {t("annotation.trashText")}
                  </button>
                  <div style={actionDividerStyle} />
                  <button
                  style={{
                    ...primaryActionStyle,
                      ...((highlightAction ?? lastDecision) === "submit" ? { boxShadow: "0 0 0 2px rgba(74,222,128,0.6)", borderColor: "#34d399" } : {}),
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
                  {t("common.submit")}
                </button>
                </div>
              </div>
              <div style={spacingRowStyle}>
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
                    setTokenGap(DEFAULT_TOKEN_GAP);
                    setTokenFontSize(DEFAULT_TOKEN_FONT_SIZE);
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
                <span style={{ color: "#94a3b8", fontSize: 12, marginLeft: 8 }}>{t("tokenEditor.size")}</span>
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
                    setTokenFontSize(DEFAULT_TOKEN_FONT_SIZE);
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
                <span style={{ color: "#94a3b8", fontSize: 12, marginLeft: 8 }}>
                  {t("tokenEditor.spaceMark") ?? "Space mark"}
                </span>
                <select
                  aria-label={t("tokenEditor.spaceMark") ?? "Space mark"}
                  value={spaceMarker}
                  onChange={(e) => setSpaceMarker(e.target.value as SpaceMarker)}
                  style={{
                    background: "rgba(30,41,59,0.85)",
                    color: "#e2e8f0",
                    border: "1px solid rgba(148,163,184,0.4)",
                    borderRadius: 8,
                    padding: "4px 8px",
                    fontSize: 12,
                    outline: "none",
                  }}
                >
                  <option value="dot">·</option>
                  <option value="box">␣</option>
                  <option value="none">{t("common.none") ?? "None"}</option>
                </select>
              </div>
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
                  background:
                    isTextPanelOpen && viewTab === "original" ? "rgba(59,130,246,0.3)" : miniNeutralButton.background,
                  borderColor: isTextPanelOpen && viewTab === "original" ? "rgba(59,130,246,0.6)" : "rgba(148,163,184,0.6)",
                }}
                onClick={() => {
                  if (viewTab === "original") {
                    setIsTextPanelOpen((v) => !v);
                  } else {
                    setViewTab("original");
                    setIsTextPanelOpen(true);
                  }
                }}
                aria-pressed={isTextPanelOpen && viewTab === "original"}
              >
                {t("tokenEditor.original") ?? "Original"}
              </button>
              <button
                style={{
                  ...miniNeutralButton,
                  background:
                    isTextPanelOpen && viewTab === "corrected" ? "rgba(59,130,246,0.3)" : miniNeutralButton.background,
                  borderColor: isTextPanelOpen && viewTab === "corrected" ? "rgba(59,130,246,0.6)" : "rgba(148,163,184,0.6)",
                }}
                onClick={() => {
                  if (viewTab === "corrected") {
                    setIsTextPanelOpen((v) => !v);
                  } else {
                    setViewTab("corrected");
                    setIsTextPanelOpen(true);
                  }
                }}
                aria-pressed={isTextPanelOpen && viewTab === "corrected"}
              >
                {t("tokenEditor.corrected") ?? "Corrected"}
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
            </div>
          )}
        </div>

        <TokenRow
          tokens={tokens}
          tokenGap={tokenGap}
          renderTokenGroups={renderTokenGroups}
          rowRef={tokenRowRef}
          moveLine={moveLine}
        />
        <ErrorTypePanel
          groupedErrorTypes={groupedErrorTypes}
          errorTypesError={errorTypesError}
          isLoadingErrorTypes={isLoadingErrorTypes}
          activeErrorTypeId={activeErrorTypeId}
          locale={locale}
          onTypePick={handleTypePick}
          onOpenSettings={handleOpenSettings}
          t={t}
        />
        </div>

      </div>

      {showClearConfirm && (
        <div style={modalOverlayStyle}>
          <div style={modalContentStyle}>
            <p style={{ color: "#e2e8f0", marginBottom: 12 }}>{t("tokenEditor.clearConfirmMessage") ?? "Clear all corrections?"}</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={miniOutlineButton} onClick={closeClearConfirm}>
                {t("tokenEditor.clearCancel") ?? "Cancel"}
              </button>
              <button
                style={{ ...miniOutlineButton, borderColor: "rgba(239,68,68,0.6)", color: "#fecdd3" }}
                onClick={() => {
                  closeClearConfirm();
                  markSkipAutoSelect();
                  dispatch({ type: "CLEAR_ALL" });
                  setSelection({ start: null, end: null });
                  endEdit();
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
              onChange={(e) => updateFlagReason(e.target.value)}
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
                {pendingAction === "skip" ? t("annotation.skipConfirm") : t("annotation.trashConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

type TokenRowProps = {
  tokens: Token[];
  tokenGap: number;
  renderTokenGroups: (tokens: Token[]) => React.ReactNode[];
  rowRef: React.RefObject<HTMLDivElement>;
  moveLine: { x1: number; y1: number; x2: number; y2: number } | null;
};

const TokenRow: React.FC<TokenRowProps> = ({
  tokens,
  tokenGap,
  renderTokenGroups,
  rowRef,
  moveLine,
}) => (
  <div
    data-testid="corrected-panel"
    style={{ ...tokenRowStyleBase, gap: Math.max(0, tokenGap) }}
    ref={rowRef}
  >
    {moveLine && (
      <svg
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      >
        <defs>
          <marker
            id="move-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(94,234,212,0.85)" />
          </marker>
        </defs>
        <line
          x1={moveLine.x1}
          y1={moveLine.y1}
          x2={moveLine.x2}
          y2={moveLine.y2}
          stroke="rgba(94,234,212,0.85)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
          markerEnd="url(#move-arrow)"
        />
      </svg>
    )}
    {renderTokenGroups(tokens)}
    <div
      style={{ width: 24, height: 24 }}
    />
  </div>
);

type ErrorTypePanelProps = {
  groupedErrorTypes: Array<{ label: string; items: ErrorType[] }>;
  errorTypesError: string | null;
  isLoadingErrorTypes: boolean;
  activeErrorTypeId: number | null;
  locale: string;
  onTypePick: (typeId: number) => void;
  onOpenSettings: () => void;
  t: (key: string) => string;
};

const ErrorTypePanel: React.FC<ErrorTypePanelProps> = ({
  groupedErrorTypes,
  errorTypesError,
  isLoadingErrorTypes,
  activeErrorTypeId,
  locale,
  onTypePick,
  onOpenSettings,
  t,
}) => (
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
          onClick={onOpenSettings}
          title={t("common.settings")}
        >
          ⚙
        </button>
      </div>
    </div>
    {errorTypesError && <div style={{ color: "#fca5a5", fontSize: 12 }}>{errorTypesError}</div>}
    {!isLoadingErrorTypes && !errorTypesError && groupedErrorTypes.length === 0 && (
      <div style={{ color: "#94a3b8", fontSize: 12 }}>{t("annotation.noErrorTypesTitle")}</div>
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
                  onClick={() => onTypePick(type.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onTypePick(type.id);
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
);

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
  gap: 8,
  flexWrap: "wrap",
};

const mainColumnStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  flex: 1,
  minWidth: 0,
};

const workspaceStyle: React.CSSProperties = {
  background: "rgba(15,23,42,0.9)",
  borderRadius: 14,
  padding: 8,
  border: "1px solid rgba(51,65,85,0.7)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  position: "relative",
};

const rowLabelStyle: React.CSSProperties = {
  color: "#cbd5e1",
  fontSize: 12,
  marginBottom: 8,
};

const tokenRowStyleBase: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  background: "rgba(15,23,42,0.6)",
  padding: "8px 12px",
  borderRadius: 12,
  border: "1px solid rgba(51,65,85,0.6)",
  position: "relative",
};

const actionBarStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "6px 0",
};

const toolbarRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 10,
};

const actionGroupStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  marginLeft: "auto",
};

const spacingRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const actionFeedbackStyle: React.CSSProperties = {
  minHeight: 2,
  marginTop: 2,
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
  padding: 12,
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
