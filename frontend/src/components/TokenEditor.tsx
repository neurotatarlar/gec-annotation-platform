import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { ErrorType, SaveStatus } from "../types";
import { useCorrectionSelection } from "../hooks/useCorrectionSelection";
import { useCorrectionTypes } from "../hooks/useCorrectionTypes";
import { useEditorUIState } from "../hooks/useEditorUIState";
import { useAnnotationsLoader } from "../hooks/useAnnotationsLoader";
import { useSaveController } from "../hooks/useSaveController";
import { useErrorTypes } from "../hooks/useErrorTypes";
import { useTokenDragDrop } from "../hooks/useTokenDragDrop";
import { useTokenDeleteRange } from "../hooks/useTokenDeleteRange";
import { useTokenSelectionHandlers } from "../hooks/useTokenSelectionHandlers";
import {
  getErrorTypeLabel,
  getErrorTypeSuperLabel,
  resolveErrorTypeColor,
} from "../utils/errorTypes";
import {
  detectCapitalizationEdit,
  detectSingleWhitespaceEdit,
  detectSpellingEdit,
  isPlainWordToken,
} from "./TokenEditorAutopick";
import { TokenGap } from "./TokenEditorGap";
import { TokenEditorGroup } from "./TokenEditorGroup";
import { buildTokenGroups } from "./TokenEditorGrouping";
import {
  EditorPresentState,
  HotkeySpec,
  MoveMarker,
  Token,
  computeLineBreaksFromText,
  hydrateFromServerAnnotations as hydrateFromServerAnnotationsModel,
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
  isInsertPlaceholder,
  makeEmptyPlaceholder,
  normalizeHotkeySpec,
  rangeToArray,
  tokenizeToTokens,
  tokenEditorReducer,
  unwindToOriginal,
} from "./TokenEditorModel";
import { createGapCalculator, SpaceMarker } from "./TokenEditorSpacing";
import {
  loadEditorState,
  loadPrefs,
  normalizeSpaceMarker,
  persistPrefs,
} from "./TokenEditorStorage";
import {
  actionBarStyle,
  actionDividerStyle,
  actionFeedbackStyle,
  actionGroupStyle,
  categoryChipStyle,
  categoryColors,
  categoryPanelStyle,
  chipBase,
  chipStyles,
  dangerActionStyle,
  mainColumnStyle,
  miniNeutralButton,
  miniOutlineButton,
  modalContentStyle,
  modalOverlayStyle,
  pageStyle,
  primaryActionStyle,
  rowLabelStyle,
  secondaryActionStyle,
  spacingRowStyle,
  tokenRowStyleBase,
  toolbarRowStyle,
  twoColumnLayoutStyle,
  workspaceStyle,
} from "./TokenEditorStyles";

export * from "./TokenEditorModel";

// ---------------------------
// Component
// ---------------------------

const MIN_TOKEN_GAP = 0;
const MAX_TOKEN_GAP = 40;
const DEFAULT_TOKEN_GAP = Math.round((MIN_TOKEN_GAP + MAX_TOKEN_GAP) / 2);
const DEFAULT_TOKEN_FONT_SIZE = 24;

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
  const queryClient = useQueryClient();

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
  const [tokenGap, setTokenGap] = useState(
    Math.max(MIN_TOKEN_GAP, prefs.tokenGap ?? DEFAULT_TOKEN_GAP)
  );
  const [tokenFontSize, setTokenFontSize] = useState(prefs.tokenFontSize ?? DEFAULT_TOKEN_FONT_SIZE);
  const [spaceMarker, setSpaceMarker] = useState<SpaceMarker>(normalizeSpaceMarker(prefs.spaceMarker));
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const suppressBlurCommitRef = useRef(false);
  const tokenRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const selectionRef = useRef(selection);
  const lastClickedIndexRef = useRef<number | null>(null);
  const gapLayoutRef = useRef<{
    left: number;
    top: number;
    positions: Array<{ index: number; midX: number; midY: number }>;
  }>({
    left: 0,
    top: 0,
    positions: [],
  });
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
  const [hoveredMoveId, setHoveredMoveId] = useState<string | null>(null);
  const [moveLine, setMoveLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSkipping, setIsSkipping] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [flashTypeId, setFlashTypeId] = useState<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const updateGapPositions = useCallback(() => {
    const row = tokenRowRef.current;
    if (!row) {
      gapLayoutRef.current = { left: 0, top: 0, positions: [] };
      return;
    }
    const containerRect = row.getBoundingClientRect();
    const gaps = row.querySelectorAll<HTMLElement>("[data-drop-index]");
    const positions: Array<{ index: number; midX: number; midY: number }> = [];
    gaps.forEach((gap) => {
      const rect = gap.getBoundingClientRect();
      const idx = Number(gap.dataset.dropIndex);
      if (Number.isNaN(idx)) return;
      positions.push({
        index: idx,
        midX: rect.left - containerRect.left + rect.width / 2,
        midY: rect.top - containerRect.top + rect.height / 2,
      });
    });
    gapLayoutRef.current = { left: containerRect.left, top: containerRect.top, positions };
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  const triggerTypeFlash = useCallback((typeId: number) => {
    setFlashTypeId(typeId);
    if (flashTimerRef.current) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      setFlashTypeId((prev) => (prev === typeId ? null : prev));
      flashTimerRef.current = null;
    }, 260);
  }, []);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  const initialViewTab = useMemo<"original" | "corrected">(() => {
    if (prefs.viewTab === "original" || prefs.viewTab === "corrected") {
      return prefs.viewTab;
    }
    return "corrected";
  }, [prefs.viewTab]);
  const [viewTab, setViewTab] = useState<"original" | "corrected">(initialViewTab);
  const [isTextPanelOpen, setIsTextPanelOpen] = useState<boolean>(prefs.textPanelOpen ?? true);
  const [hasLoadedAnnotations, setHasLoadedAnnotations] = useState(false);
  const lineBreaks = useMemo(
    () => computeLineBreaksFromText(initialText),
    [initialText]
  );
  const [renderEpoch, setRenderEpoch] = useState(0);
  const [canonicalEpoch, setCanonicalEpoch] = useState(0);
  const [canonicalCorrectedText, setCanonicalCorrectedText] = useState<string | null>(null);
  const [isRenderPending, setIsRenderPending] = useState(false);
  const [hasCanonicalRender, setHasCanonicalRender] = useState(false);
  const renderRequestIdRef = useRef(0);
  const renderAbortRef = useRef<AbortController | null>(null);
  const { lineBreakSet, lineBreakCountMap } = useMemo(() => {
    const set = new Set(lineBreaks);
    const map = new Map<number, number>();
    lineBreaks.forEach((idx) => {
      map.set(idx, (map.get(idx) ?? 0) + 1);
    });
    return { lineBreakSet: set, lineBreakCountMap: map };
  }, [lineBreaks]);
  const lastSavedSignatureRef = useRef<string | null>(null);
  const [lastDecision, setLastDecision] = useState<"skip" | "trash" | "submit" | null>(
    prefs.lastTextId === textId ? prefs.lastDecision ?? null : null
  );
  const [serverAnnotationVersion, setServerAnnotationVersion] = useState(0);
  const annotationIdMap = useRef<Map<string, number>>(new Map());
  const annotationDeleteMap = useRef<Map<string, number[]>>(new Map());
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
  useEffect(() => {
    updateGapPositions();
  }, [tokens, tokenGap, tokenFontSize, lineBreaks, updateGapPositions]);
  useEffect(() => {
    const handleResize = () => updateGapPositions();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [updateGapPositions]);
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
    setCanonicalCorrectedText(null);
    setCanonicalEpoch(0);
    setRenderEpoch(0);
    setIsRenderPending(false);
    setHasCanonicalRender(false);
    setHasLoadedAnnotations(false);
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

  const hydrateFromServerAnnotations = useCallback(
    (items: any[]) =>
      hydrateFromServerAnnotationsModel({
        items,
        initialText,
        currentUserId,
      }),
    [initialText, currentUserId]
  );

  useEffect(() => {
    try {
      localStorage.setItem("lastAnnotationPath", location.pathname);
    } catch {
      // ignore
    }
  }, [location.pathname]);

  const loadErrorTypes = useCallback(async () => {
    const response = await get("/api/error-types/");
    return response.data as ErrorType[];
  }, [get]);

  const { errorTypes, isLoadingErrorTypes, errorTypesError } = useErrorTypes({
    enabled: true,
    loadErrorTypes,
  });

  // Update selection highlight by toggling selected flag (not stored in history).
  const selectedSet = useMemo(() => new Set(selectedIndices), [selectedIndices]);
  const activeErrorTypes = useMemo(
    () =>
      errorTypes
        .filter((type) => type.is_active)
        .slice()
        .sort((a, b) => {
          const aCategory = (a.category_en ?? "").toLowerCase();
          const bCategory = (b.category_en ?? "").toLowerCase();
          if (aCategory !== bCategory) {
            return aCategory.localeCompare(bCategory);
          }
          const aOrder = a.sort_order ?? 0;
          const bOrder = b.sort_order ?? 0;
          if (aOrder !== bOrder) {
            return aOrder - bOrder;
          }
          const aName = (a.en_name ?? "").toLowerCase();
          const bName = (b.en_name ?? "").toLowerCase();
          if (aName !== bName) {
            return aName.localeCompare(bName);
          }
          return a.id - b.id;
        }),
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
    const srcCenter = { x: srcRect.left + srcRect.width / 2, y: srcRect.top + srcRect.height / 2 };
    const dstCenter = { x: dstRect.left + dstRect.width / 2, y: dstRect.top + dstRect.height / 2 };
    const findEdgePoint = (from: { x: number; y: number }, to: { x: number; y: number }, rect: DOMRect) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      if (dx === 0 && dy === 0) return from;
      const candidates: Array<{ t: number; x: number; y: number }> = [];
      if (dx !== 0) {
        const tLeft = (rect.left - from.x) / dx;
        const yLeft = from.y + tLeft * dy;
        if (tLeft > 0 && tLeft < 1 && yLeft >= rect.top && yLeft <= rect.bottom) {
          candidates.push({ t: tLeft, x: rect.left, y: yLeft });
        }
        const tRight = (rect.right - from.x) / dx;
        const yRight = from.y + tRight * dy;
        if (tRight > 0 && tRight < 1 && yRight >= rect.top && yRight <= rect.bottom) {
          candidates.push({ t: tRight, x: rect.right, y: yRight });
        }
      }
      if (dy !== 0) {
        const tTop = (rect.top - from.y) / dy;
        const xTop = from.x + tTop * dx;
        if (tTop > 0 && tTop < 1 && xTop >= rect.left && xTop <= rect.right) {
          candidates.push({ t: tTop, x: xTop, y: rect.top });
        }
        const tBottom = (rect.bottom - from.y) / dy;
        const xBottom = from.x + tBottom * dx;
        if (tBottom > 0 && tBottom < 1 && xBottom >= rect.left && xBottom <= rect.right) {
          candidates.push({ t: tBottom, x: xBottom, y: rect.bottom });
        }
      }
      if (!candidates.length) return from;
      const closest = candidates.reduce((a, b) => (a.t < b.t ? a : b));
      return { x: closest.x, y: closest.y };
    };
    const srcEdge = findEdgePoint(srcCenter, dstCenter, srcRect);
    const dstEdge = findEdgePoint(dstCenter, srcCenter, dstRect);
    const x1 = srcEdge.x - containerRect.left;
    const y1 = srcEdge.y - containerRect.top;
    const x2 = dstEdge.x - containerRect.left;
    const y2 = dstEdge.y - containerRect.top;
    setMoveLine({ x1, y1, x2, y2 });
  }, [hoveredMoveId, moveMarkerById]);
  const correctionCards = useMemo(
    () => deriveCorrectionCards(tokens, moveMarkers),
    [tokens, moveMarkers]
  );
  const moveCardIds = useMemo(
    () => new Set(moveMarkers.map((marker) => marker.id)),
    [moveMarkers]
  );
  const wordOrderTypeId = useMemo(() => {
    const match = errorTypes.find(
      (type) => type.en_name?.trim().toLowerCase() === "wordorder"
    );
    return match?.id ?? null;
  }, [errorTypes]);
  const hyphenTypeId = useMemo(() => {
    const match = errorTypes.find(
      (type) => type.en_name?.trim().toLowerCase() === "hyphen"
    );
    return match?.id ?? null;
  }, [errorTypes]);
  const punctuationTypeId = useMemo(() => {
    const match = errorTypes.find(
      (type) => type.en_name?.trim().toLowerCase() === "punctuation"
    );
    return match?.id ?? null;
  }, [errorTypes]);
  const splitTypeId = useMemo(() => {
    const match = errorTypes.find(
      (type) => type.en_name?.trim().toLowerCase() === "split"
    );
    return match?.id ?? null;
  }, [errorTypes]);
  const mergeTypeId = useMemo(() => {
    const match = errorTypes.find(
      (type) => type.en_name?.trim().toLowerCase() === "merge"
    );
    return match?.id ?? null;
  }, [errorTypes]);
  const capitalLowerTypeId = useMemo(() => {
    const match = errorTypes.find(
      (type) => type.en_name?.trim().toLowerCase() === "capitallowerletter"
    );
    return match?.id ?? null;
  }, [errorTypes]);
  const spellingTypeId = useMemo(() => {
    const match = errorTypes.find(
      (type) => type.en_name?.trim().toLowerCase() === "spelling"
    );
    return match?.id ?? null;
  }, [errorTypes]);
  const correctionCardById = useMemo(() => {
    const map = new Map<string, CorrectionCardLite>();
    correctionCards.forEach((card) => map.set(card.id, card));
    return map;
  }, [correctionCards]);
  const isSingleHyphenEdit = useCallback((beforeText: string, afterText: string) => {
    if (beforeText === afterText) return false;
    const countHyphen = (value: string) => (value.match(/-/g) ?? []).length;
    const hasSingleHyphen = (value: string) => countHyphen(value) === 1;
    const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
    const isHyphenBetweenWordChars = (value: string) => {
      const idx = value.indexOf("-");
      if (idx <= 0 || idx >= value.length - 1) return false;
      return isWordChar(value[idx - 1]) && isWordChar(value[idx + 1]);
    };
    const beforeHas = hasSingleHyphen(beforeText);
    const afterHas = hasSingleHyphen(afterText);
    if (beforeHas === afterHas) return false;
    if (beforeHas && !afterText.includes("-")) {
      if (beforeText.replace("-", "") !== afterText) return false;
      return isHyphenBetweenWordChars(beforeText);
    }
    if (afterHas && !beforeText.includes("-")) {
      if (afterText.replace("-", "") !== beforeText) return false;
      return isHyphenBetweenWordChars(afterText);
    }
    return false;
  }, []);
  const isSingleTokenDelta = useCallback(
    (beforeTokens: Token[], afterTokens: Token[], predicate: (tok: Token) => boolean) => {
      const matches = (left: Token, right: Token) =>
        left.text === right.text && left.kind === right.kind;
      if (afterTokens.length === beforeTokens.length + 1) {
        for (let i = 0; i < afterTokens.length; i += 1) {
          if (!predicate(afterTokens[i])) continue;
          const without = [...afterTokens.slice(0, i), ...afterTokens.slice(i + 1)];
          if (without.length !== beforeTokens.length) continue;
          if (without.every((tok, idx) => matches(tok, beforeTokens[idx]))) return true;
        }
      }
      if (beforeTokens.length === afterTokens.length + 1) {
        for (let i = 0; i < beforeTokens.length; i += 1) {
          if (!predicate(beforeTokens[i])) continue;
          const without = [...beforeTokens.slice(0, i), ...beforeTokens.slice(i + 1)];
          if (without.length !== afterTokens.length) continue;
          if (without.every((tok, idx) => matches(tok, afterTokens[idx]))) return true;
        }
      }
      return false;
    },
    []
  );
  const isHyphenCorrection = useCallback(
    (cardId: string) => {
      if (moveCardIds.has(cardId)) return false;
      const card = correctionCardById.get(cardId);
      if (!card) return false;
      const slice = tokens.slice(card.rangeStart, card.rangeEnd + 1);
      if (!slice.length) return false;
      const anchor = slice.find((tok) => tok.previousTokens?.length);
      const historyTokens = anchor?.previousTokens ?? [];
      const historyNonEmpty = historyTokens.filter((tok) => tok.kind !== "empty");
      const currentNonEmpty = slice.filter((tok) => tok.kind !== "empty");
      if (isSingleTokenDelta(historyNonEmpty, currentNonEmpty, (tok) => tok.text === "-")) {
        return true;
      }
      if (
        slice.length === 1 &&
        slice[0].kind === "empty" &&
        historyNonEmpty.length === 1 &&
        historyNonEmpty[0].text === "-"
      ) {
        return true;
      }
      if (
        currentNonEmpty.length === 1 &&
        currentNonEmpty[0].text === "-" &&
        historyTokens.length > 0 &&
        historyTokens.every((tok) => tok.kind === "empty")
      ) {
        return true;
      }
      if (!historyNonEmpty.length || !currentNonEmpty.length) return false;
      const beforeText = buildEditableTextFromTokens(historyNonEmpty);
      const afterText = buildEditableTextFromTokens(currentNonEmpty);
      return isSingleHyphenEdit(beforeText, afterText);
    },
    [correctionCardById, isSingleHyphenEdit, isSingleTokenDelta, moveCardIds, tokens]
  );
  const isPunctuationCorrection = useCallback(
    (cardId: string) => {
      if (moveCardIds.has(cardId)) return false;
      const card = correctionCardById.get(cardId);
      if (!card) return false;
      const slice = tokens.slice(card.rangeStart, card.rangeEnd + 1);
      if (!slice.length) return false;
      const anchor = slice.find((tok) => tok.previousTokens?.length);
      const historyTokens = anchor?.previousTokens ?? [];
      const historyNonEmpty = historyTokens.filter((tok) => tok.kind !== "empty");
      const currentNonEmpty = slice.filter((tok) => tok.kind !== "empty");
      if (
        isSingleTokenDelta(
          historyNonEmpty,
          currentNonEmpty,
          (tok) => tok.kind === "punct" && tok.text !== "-"
        )
      ) {
        return true;
      }
      if (
        slice.length === 1 &&
        slice[0].kind === "empty" &&
        historyNonEmpty.length === 1 &&
        historyNonEmpty[0].kind === "punct" &&
        historyNonEmpty[0].text !== "-"
      ) {
        return true;
      }
      if (
        currentNonEmpty.length === 1 &&
        currentNonEmpty[0].kind === "punct" &&
        currentNonEmpty[0].text !== "-" &&
        historyTokens.length > 0 &&
        historyTokens.every((tok) => tok.kind === "empty")
      ) {
        return true;
      }
      return false;
    },
    [correctionCardById, isSingleTokenDelta, moveCardIds, tokens]
  );
  const getWhitespaceCorrection = useCallback(
    (cardId: string) => {
      if (moveCardIds.has(cardId)) return null;
      const card = correctionCardById.get(cardId);
      if (!card) return null;
      const slice = tokens.slice(card.rangeStart, card.rangeEnd + 1);
      if (!slice.length) return null;
      const anchor = slice.find((tok) => tok.previousTokens?.length);
      const historyTokens = anchor?.previousTokens ?? [];
      const historyNonEmpty = historyTokens.filter((tok) => tok.kind !== "empty");
      const currentNonEmpty = slice.filter((tok) => tok.kind !== "empty");
      if (!historyNonEmpty.length || !currentNonEmpty.length) return null;
      const beforeText = buildEditableTextFromTokens(historyNonEmpty);
      const afterText = buildEditableTextFromTokens(currentNonEmpty);
      return detectSingleWhitespaceEdit(beforeText, afterText);
    },
    [correctionCardById, moveCardIds, tokens]
  );
  const getSingleWordEdit = useCallback(
    (cardId: string) => {
      if (moveCardIds.has(cardId)) return null;
      const card = correctionCardById.get(cardId);
      if (!card) return null;
      const slice = tokens.slice(card.rangeStart, card.rangeEnd + 1);
      if (!slice.length) return null;
      const anchor = slice.find((tok) => tok.previousTokens?.length);
      const historyTokens = anchor?.previousTokens ?? [];
      const historyNonEmpty = historyTokens.filter((tok) => tok.kind !== "empty");
      const currentNonEmpty = slice.filter((tok) => tok.kind !== "empty");
      if (historyNonEmpty.length !== 1 || currentNonEmpty.length !== 1) return null;
      const beforeText = historyNonEmpty[0].text;
      const afterText = currentNonEmpty[0].text;
      if (!isPlainWordToken(beforeText) || !isPlainWordToken(afterText)) return null;
      return { beforeText, afterText };
    },
    [correctionCardById, moveCardIds, tokens]
  );
  const defaultTypeForCard = useCallback(
    (cardId: string) => {
      if (wordOrderTypeId && moveCardIds.has(cardId)) return wordOrderTypeId;
      const whitespaceChange = getWhitespaceCorrection(cardId);
      if (whitespaceChange === "split" && mergeTypeId) return mergeTypeId;
      if (whitespaceChange === "merge" && splitTypeId) return splitTypeId;
      if (hyphenTypeId && isHyphenCorrection(cardId)) return hyphenTypeId;
      if (punctuationTypeId && isPunctuationCorrection(cardId)) return punctuationTypeId;
      const wordEdit = getSingleWordEdit(cardId);
      if (wordEdit && capitalLowerTypeId) {
        if (detectCapitalizationEdit(wordEdit.beforeText, wordEdit.afterText, locale)) {
          return capitalLowerTypeId;
        }
      }
      if (wordEdit && spellingTypeId) {
        if (detectSpellingEdit(wordEdit.beforeText, wordEdit.afterText)) {
          return spellingTypeId;
        }
      }
      return null;
    },
    [
      capitalLowerTypeId,
      detectCapitalizationEdit,
      detectSpellingEdit,
      getSingleWordEdit,
      getWhitespaceCorrection,
      hyphenTypeId,
      isHyphenCorrection,
      isPunctuationCorrection,
      mergeTypeId,
      moveCardIds,
      punctuationTypeId,
      spellingTypeId,
      splitTypeId,
      wordOrderTypeId,
      locale,
    ]
  );

  const correctionByIndex = useMemo(
    () => deriveCorrectionByIndex(correctionCards, moveMarkers),
    [correctionCards, moveMarkers]
  );
  const {
    correctionTypeMap,
    applyTypeToCorrections,
    seedCorrectionTypes,
  } = useCorrectionTypes({ textId, correctionCards, defaultTypeForCard });

  const { markSkipAutoSelect, setPendingSelectIndex } = useCorrectionSelection({
    correctionCards,
    tokens,
    setSelection,
  });
  const revertMove = useCallback(
    (moveId: string) => {
      markSkipAutoSelect();
      setSelection({ start: null, end: null });
      endEdit();
      dispatch({ type: "REVERT_MOVE", moveId });
    },
    [dispatch, endEdit, markSkipAutoSelect, setSelection]
  );

  useAnnotationsLoader({
    textId,
    currentUserId,
    get,
    hydrateFromServerAnnotations,
    dispatch,
    seedCorrectionTypes,
    pendingLocalStateRef,
    hydratedFromServerRef,
    annotationIdMap,
    annotationDeleteMap,
    setServerAnnotationVersion,
    onLoaded: () => setHasLoadedAnnotations(true),
  });

  const requestNextText = useCallback(async () => {
    try {
      const response = await post("/api/texts/assignments/next", null, {
        params: { category_id: categoryId },
      });
      const nextId = response.data?.text?.id;
      if (nextId && nextId !== textId) {
        if (response.data?.text) {
          queryClient.setQueryData(["text", String(nextId)], response.data.text);
        }
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
  }, [get, post, categoryId, navigate, t, textId, queryClient]);

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
    suppressBlurCommitRef.current = false;
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
    suppressBlurCommitRef.current = false;
    endEdit();
    setSelection({ start, end });
  };

  // Cancel edit.
  const cancelEdit = () => {
    suppressBlurCommitRef.current = true;
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

  const {
    dropIndex,
    handleDragStart,
    handleDragOverToken,
    handleDragOverGap,
    handleDropAt,
    handleRowDragOver,
    handleRowDrop,
    handleDragEnd,
  } = useTokenDragDrop({
    tokens,
    selection,
    selectionRef,
    hasSelection,
    editingRange,
    expandRangeToGroups,
    setSelection,
    updateGapPositions,
    gapLayoutRef,
    dispatchMove: ({ fromStart, fromEnd, toIndex }) =>
      dispatch({ type: "MOVE_SELECTED_TOKENS", fromStart, fromEnd, toIndex }),
  });

  const { handleTokenClick } = useTokenSelectionHandlers({
    tokens,
    selectionRef,
    lastClickedIndexRef,
    setSelection,
  });

  const { getDeleteRange } = useTokenDeleteRange({
    tokens,
    selectionRef,
    lastClickedIndexRef,
  });

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
      const currentSelection = selectionRef.current;
      const hasSelectionNow = currentSelection.start !== null && currentSelection.end !== null;
      if (event.key === "Delete" || event.key === "Backspace") {
        if (hasSelectionNow) {
          event.preventDefault();
          const ctx = getDeleteRange();
          if (ctx) {
            dispatch({ type: "DELETE_SELECTED_TOKENS", range: ctx.range, anchorIndex: ctx.anchorIndex });
            setSelection({ start: null, end: null });
          }
        }
      }
      if (event.key === "Insert") {
        if (!hasSelectionNow) return;
        event.preventDefault();
        const [s, e] = [currentSelection.start!, currentSelection.end!];
        const start = Math.min(s, e);
        const end = Math.max(s, e);
        dispatch({ type: "INSERT_TOKEN_AFTER_SELECTED", range: [start, end] });
        // prepare to edit the new token
        const newIndex = end + 1;
        setSelection({ start: newIndex, end: newIndex });
        suppressBlurCommitRef.current = false;
        startEdit({ start: newIndex, end: newIndex }, "");
        setTimeout(() => editInputRef.current?.focus(), 10);
      }
      if (event.key === "Escape") {
        setSelection({ start: null, end: null });
      }
      if (event.key === "Enter" && hasSelectionNow) {
        event.preventDefault();
        beginEdit(undefined, editText.length);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    editingRange,
    hasSelection,
    selection,
    showClearConfirm,
    pendingAction,
    cancelFlag,
    closeClearConfirm,
    getDeleteRange,
  ]);

  const renderToken = (token: Token, index: number, forceChanged = false) => {
    const isSelected = selectedSet.has(index);
    const isMovePlaceholder = Boolean(token.moveId && token.kind === "empty");
    const isDeletionPlaceholder = Boolean(token.kind === "empty" && !token.moveId && token.previousTokens?.length);
    const hasHistory = forceChanged || (Boolean(token.previousTokens?.length) && !isMovePlaceholder);
    const isSpecial = token.kind === "special";
    const isEmpty = token.kind === "empty";
    const displayText =
      isDeletionPlaceholder
        ? "⬚"
        : isEmpty
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
      if (isMovePlaceholder) {
        const markerWidth = Math.max(2, Math.round(tokenFontSize * 0.12));
        const markerHeight = Math.max(14, Math.round(tokenFontSize * 1.1));
        Object.assign(style, {
          border: "none",
          background: "rgba(148,163,184,0.5)",
          padding: 0,
          width: markerWidth,
          minWidth: markerWidth,
          height: markerHeight,
          borderRadius: 2,
          color: "transparent",
          fontSize: 0,
        });
      } else if (isDeletionPlaceholder) {
        const ghostSize = Math.max(8, Math.round(tokenFontSize * 0.75));
        const ghostHeight = Math.max(14, Math.round(tokenFontSize * 1.05));
        Object.assign(style, {
          border: "none",
          background: "transparent",
          padding: "0 2px",
          borderRadius: 4,
          color: "#64748b",
          fontSize: ghostSize,
          lineHeight: `${ghostHeight}px`,
          height: ghostHeight,
          minHeight: ghostHeight,
        });
      }
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
      const originalSelection = buildEditableTextFromTokens(tokens.slice(editStart, editEnd + 1));
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
            onBlur={() => {
              if (suppressBlurCommitRef.current) {
                suppressBlurCommitRef.current = false;
                return;
              }
              commitEdit();
            }}
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
        aria-label={isEmpty ? "⬚" : undefined}
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
    const { getGapMetrics, markerStyle } = createGapCalculator({
      tokenGap,
      tokenFontSize,
      spaceMarker,
      isEditing: Boolean(editingRange),
    });
    const groups = buildTokenGroups(tokenList);
    let visibleCount = 0;

    const renderGap = (idx: number) => {
      const nextTok = tokens[idx];
      const prevTok = idx > 0 ? tokens[idx - 1] : null;
      const isLineStart = lineStartIndices.has(idx);
      const { width: gapWidth, markerChar } = getGapMetrics(prevTok, nextTok, isLineStart);
      return (
        <TokenGap
          key={`gap-${idx}`}
          index={idx}
          width={gapWidth}
          height={Math.max(28, tokenFontSize * 1.2)}
          markerChar={markerChar}
          markerStyle={markerStyle}
          isActive={dropIndex === idx}
          onDragOver={(event) => handleDragOverGap(idx, event)}
          onDrop={() => handleDropAt(idx)}
        />
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
      const resolvedType = typeId ? errorTypeById.get(typeId) ?? null : null;
      const typeObj = isMoveGroup && !isMoveDestination ? null : resolvedType;
      const badgeText = typeObj ? getErrorTypeLabel(typeObj, locale) : "";
      const badgeColor = resolveErrorTypeColor(typeObj?.default_color);
      const badgeFontSize = Math.max(8, tokenFontSize * 0.45);
      const badgePaddingY = Math.max(0.5, tokenFontSize * 0.07);
      const badgePaddingX = Math.max(2, tokenFontSize * 0.18);
      const badgeRadius = Math.max(6, tokenFontSize * 0.45);
      const isPurePunctGroup = group.tokens.every((t) => t.kind === "punct");
      // Update visible counter for line breaks (count only rendered tokens).
      group.tokens.forEach((tok) => {
        if (tok.kind !== "empty") visibleCount += 1;
      });
      const showBorder = hasHistory || isMoveGroup;
      const showHistoryTokens = hasHistory && !isMoveGroup;
      const showUndo = (hasHistory && !isMoveGroup) || (isMoveDestination && moveId);
      const isMoveHover = Boolean(moveId && hoveredMoveId === moveId);
      const isMoveSource = isMoveGroup && !isMoveDestination;

      const groupPadX = isMoveSource ? 0 : isPurePunctGroup ? 0 : 1;
      const movePlaceholderHeight = Math.max(14, Math.round(tokenFontSize * 1.1));
      const groupKey = `range:${group.start}-${group.end}`;
      const isPlainGroup = !hasHistory && !isMoveGroup && !typeObj;

      if (isPlainGroup && group.tokens.length === 1) {
        result.push(renderToken(group.tokens[0], group.start));
        const lineBreakHeight = Math.max(4, Math.round(tokenFontSize * 0.45));
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
                }}
              />
            );
          }
        }
        result.push(renderGap(group.end + 1));
        return;
      }

      result.push(
        <TokenEditorGroup
          key={groupKey}
          group={group}
          groupIndex={groupIndex}
          tokenFontSize={tokenFontSize}
          t={t}
          historyTokens={historyTokens}
          hasHistory={hasHistory}
          moveId={moveId ?? null}
          isMoveGroup={isMoveGroup}
          isMoveDestination={isMoveDestination}
          isMoveSource={isMoveSource}
          isMoveHover={isMoveHover}
          showBorder={showBorder}
          showHistoryTokens={showHistoryTokens}
          showUndo={showUndo}
          isPurePunctGroup={isPurePunctGroup}
          typeObj={typeObj}
          badgeText={badgeText}
          badgeColor={badgeColor}
          badgeFontSize={badgeFontSize}
          badgePaddingY={badgePaddingY}
          badgePaddingX={badgePaddingX}
          badgeRadius={badgeRadius}
          groupPadX={groupPadX}
          movePlaceholderHeight={movePlaceholderHeight}
          dropIndex={dropIndex}
          markerStyle={markerStyle}
          previousTokenStyle={chipStyles.previous}
          previousTokenFontStyle={chipStyles.previous.fontStyle as string | undefined}
          measureTextWidth={measureTextWidth}
          getGapMetrics={getGapMetrics}
          renderToken={renderToken}
          onHandleDragOverGap={handleDragOverGap}
          onHandleDropAt={handleDropAt}
          onHandleRevert={(start, end) => {
            handleRevert(start, end);
            setSelection({ start: null, end: null });
            endEdit();
          }}
          onRevertMove={revertMove}
          onSelectRange={(range) => {
            selectionRef.current = range;
            lastClickedIndexRef.current = range.start;
            setSelection(range);
          }}
          onMoveEnter={(id) => setHoveredMoveId(id)}
          onMoveLeave={(id) => setHoveredMoveId((prev) => (prev === id ? null : prev))}
          setGroupRef={(el) => {
            groupRefs.current[groupKey] = el;
          }}
        />
      );
      const lineBreakHeight = Math.max(4, Math.round(tokenFontSize * 0.45));
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
        annotationDeleteMap: annotationDeleteMap.current,
        includeDeletedIds: true,
      }),
    [annotationIdMap, correctionCards, correctionTypeMap, initialText, moveMarkers, originalTokens, tokens]
  );

  const buildRenderPayload = useCallback(
    () =>
      buildAnnotationsPayloadStandalone({
        initialText,
        tokens,
        originalTokens,
        correctionCards,
        correctionTypeMap,
        moveMarkers,
        annotationIdMap: annotationIdMap.current,
        allowUnassigned: true,
        defaultErrorTypeId: 0,
        includeClientCorrectionId: true,
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

  const localCorrectedText = useMemo(
    () => buildTextFromTokensWithBreaks(tokens, lineBreaks),
    [tokens, lineBreaks]
  );

  useEffect(() => {
    if (process.env.NODE_ENV === "test") return;
    if (!tokens.length) return;
    renderRequestIdRef.current += 1;
    const requestId = renderRequestIdRef.current;
    setRenderEpoch(requestId);
    const hasCorrections = correctionCards.length > 0;
    if (!hasCorrections) {
      setCanonicalCorrectedText(localCorrectedText);
      setCanonicalEpoch(requestId);
      setIsRenderPending(false);
      if (hasLoadedAnnotations) {
        setHasCanonicalRender(true);
      }
      return;
    }
    setIsRenderPending(true);
    let timer: number | null = window.setTimeout(async () => {
      if (renderAbortRef.current) {
        renderAbortRef.current.abort();
      }
      const controller = new AbortController();
      renderAbortRef.current = controller;
      try {
        const annotations = await buildRenderPayload();
        const response = await post(
          `/api/texts/${textId}/render`,
          { annotations },
          { signal: controller.signal }
        );
        if (renderRequestIdRef.current !== requestId) return;
        const correctedText = response?.data?.corrected_text ?? localCorrectedText;
        setCanonicalCorrectedText(correctedText);
        setCanonicalEpoch(requestId);
        setHasCanonicalRender(true);
      } catch (error: any) {
        if (!controller.signal.aborted && renderRequestIdRef.current === requestId) {
          setCanonicalCorrectedText(localCorrectedText);
          setCanonicalEpoch(requestId);
          setHasCanonicalRender(true);
        }
      } finally {
        if (renderRequestIdRef.current === requestId) {
          setIsRenderPending(false);
          timer = null;
        }
      }
    }, 450);
    return () => {
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [
    buildRenderPayload,
    correctionCards.length,
    hasLoadedAnnotations,
    localCorrectedText,
    post,
    textId,
    tokens.length,
  ]);

  const correctedText = useMemo(() => {
    if (canonicalEpoch === renderEpoch && canonicalCorrectedText != null) {
      return canonicalCorrectedText;
    }
    return localCorrectedText;
  }, [canonicalCorrectedText, canonicalEpoch, localCorrectedText, renderEpoch]);
  const showCorrectedSpinner =
    viewTab === "corrected" && (!hasLoadedAnnotations || (isRenderPending && !hasCanonicalRender));

  useEffect(() => {
    return () => {
      if (renderAbortRef.current) {
        renderAbortRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    persistPrefs({
      tokenGap,
      tokenFontSize,
      spaceMarker,
      lastDecision,
      lastTextId: textId,
      viewTab,
      textPanelOpen: isTextPanelOpen,
    });
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
      if (!typeId) return false;
      if (!selectedIndices.length) return false;
      const affectedIds = new Set<string>();
      selectedIndices.forEach((idx) => {
        const cardId = correctionByIndex.get(idx);
        if (cardId) affectedIds.add(cardId);
      });
      if (!affectedIds.size) return false;
      applyTypeToCorrections(affectedIds, typeId);
      return true;
    },
    [applyTypeToCorrections, correctionByIndex, selectedIndices]
  );

  const handleTypePick = useCallback(
    (typeId: number) => {
      applyTypeToSelection(typeId);
      triggerTypeFlash(typeId);
    },
    [applyTypeToSelection, triggerTypeFlash]
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
                  const ctx = getDeleteRange();
                  if (!ctx) return;
                  dispatch({ type: "DELETE_SELECTED_TOKENS", range: ctx.range, anchorIndex: ctx.anchorIndex });
                  setSelection({ start: null, end: null });
                }, !hasSelectionTokens, "Del", "🗑️")}
                {toolbarButton(t("tokenEditor.insertBefore"), () => {
                  if (!hasSelectionTokens) return;
                  const currentSelection = selectionRef.current;
                  if (currentSelection.start === null || currentSelection.end === null) return;
                  const [s, e] = [currentSelection.start, currentSelection.end];
                  const start = Math.min(s, e);
                dispatch({ type: "INSERT_TOKEN_BEFORE_SELECTED", range: [start, Math.max(s, e)] });
                // Immediately enter edit mode on the newly inserted token.
                setSelection({ start, end: start });
                suppressBlurCommitRef.current = false;
                startEdit({ start, end: start }, "");
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
                  const currentSelection = selectionRef.current;
                  if (currentSelection.start === null || currentSelection.end === null) return;
                  const [s, e] = [currentSelection.start, currentSelection.end];
                  const start = Math.min(s, e);
                  const end = Math.max(s, e);
                  dispatch({ type: "INSERT_TOKEN_AFTER_SELECTED", range: [start, end] });
                  const newIndex = end + 1;
                  setSelection({ start: newIndex, end: newIndex });
                  suppressBlurCommitRef.current = false;
                  startEdit({ start: newIndex, end: newIndex }, "");
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
                  onClick={() => setTokenGap((g) => Math.max(MIN_TOKEN_GAP, g - 3))}
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
                  onClick={() => setTokenGap((g) => Math.min(MAX_TOKEN_GAP, g + 3))}
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
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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
              {viewTab === "corrected" && showCorrectedSpinner ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#94a3b8", fontSize: 13 }}>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeDasharray="24 12"
                    >
                      <animateTransform
                        attributeName="transform"
                        type="rotate"
                        from="0 12 12"
                        to="360 12 12"
                        dur="0.9s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  </svg>
                  <span>{t("common.loading") ?? "Loading"}</span>
                </div>
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
                    : correctedText}
                </span>
              )}
            </div>
          )}
        </div>

        <TokenRow
          tokens={tokens}
          tokenGap={tokenGap}
          renderTokenGroups={renderTokenGroups}
          rowRef={tokenRowRef}
          moveLine={moveLine}
          showSpinner={isRenderPending}
          onDragOver={handleRowDragOver}
          onDrop={handleRowDrop}
        />
        <ErrorTypePanel
          groupedErrorTypes={groupedErrorTypes}
          errorTypesError={errorTypesError}
          isLoadingErrorTypes={isLoadingErrorTypes}
          flashTypeId={flashTypeId}
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
  showSpinner?: boolean;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
};

const TokenRow: React.FC<TokenRowProps> = ({
  tokens,
  tokenGap,
  renderTokenGroups,
  rowRef,
  moveLine,
  showSpinner,
  onDragOver,
  onDrop,
}) => (
  <div
    data-testid="corrected-panel"
    style={{ ...tokenRowStyleBase, gap: 0 }}
    ref={rowRef}
    onDragOver={onDragOver}
    onDrop={onDrop}
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
    {showSpinner && (
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          width: 22,
          height: 22,
          borderRadius: 999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(15,23,42,0.7)",
          border: "1px solid rgba(148,163,184,0.4)",
          pointerEvents: "none",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24">
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray="24 12"
          >
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 12 12"
              to="360 12 12"
              dur="0.9s"
              repeatCount="indefinite"
            />
          </circle>
        </svg>
      </div>
    )}
  </div>
);

type ErrorTypePanelProps = {
  groupedErrorTypes: Array<{ label: string; items: ErrorType[] }>;
  errorTypesError: string | null;
  isLoadingErrorTypes: boolean;
  flashTypeId: number | null;
  locale: string;
  onTypePick: (typeId: number) => void;
  onOpenSettings: () => void;
  t: (key: string) => string;
};

const ErrorTypePanel: React.FC<ErrorTypePanelProps> = ({
  groupedErrorTypes,
  errorTypesError,
  isLoadingErrorTypes,
  flashTypeId,
  locale,
  onTypePick,
  onOpenSettings,
  t,
}) => {
  const [hoveredTypeId, setHoveredTypeId] = useState<number | null>(null);
  const [pressedTypeId, setPressedTypeId] = useState<number | null>(null);

  return (
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
              const chipBg = resolveErrorTypeColor(
                type.default_color,
                categoryColors[(groupIdx + idx) % categoryColors.length]
              );
              const hotkey = (type.default_hotkey ?? "").trim();
              const isHover = hoveredTypeId === type.id;
              const isPressed = pressedTypeId === type.id;
              const isFlash = flashTypeId === type.id;
              const borderColor = isPressed
                ? "rgba(226,232,240,0.9)"
                : isFlash
                  ? "rgba(16,185,129,0.85)"
                  : isHover
                    ? "rgba(226,232,240,0.55)"
                    : "rgba(148,163,184,0.35)";
              return (
                <div
                  key={type.id}
                  style={{
                    ...categoryChipStyle,
                    background: chipBg,
                    border: `${isFlash || isPressed ? 2 : 1}px solid ${borderColor}`,
                    boxShadow: isFlash
                      ? "0 0 0 2px rgba(16,185,129,0.25)"
                      : isHover
                        ? "0 0 0 1px rgba(226,232,240,0.2)"
                        : "none",
                    transform: isPressed ? "translateY(1px)" : "none",
                    transition: "transform 0.08s ease, box-shadow 0.2s ease, border-color 0.2s ease",
                    color: "rgba(248,250,252,0.85)",
                  }}
                  title={type.description ?? undefined}
                  role="button"
                  tabIndex={0}
                  onClick={() => onTypePick(type.id)}
                  onMouseEnter={() => setHoveredTypeId(type.id)}
                  onMouseLeave={() => {
                    setHoveredTypeId((prev) => (prev === type.id ? null : prev));
                    setPressedTypeId((prev) => (prev === type.id ? null : prev));
                  }}
                  onMouseDown={() => setPressedTypeId(type.id)}
                  onMouseUp={() => setPressedTypeId((prev) => (prev === type.id ? null : prev))}
                  onFocus={() => setHoveredTypeId(type.id)}
                  onBlur={() => {
                    setHoveredTypeId((prev) => (prev === type.id ? null : prev));
                    setPressedTypeId((prev) => (prev === type.id ? null : prev));
                  }}
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
                          color: "rgba(248,250,252,0.7)",
                          border: "1px solid rgba(248,250,252,0.25)",
                          borderRadius: 6,
                          padding: "2px 6px",
                          background: "rgba(15,23,42,0.2)",
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
};

// ---------------------------
// Styles
// ---------------------------
