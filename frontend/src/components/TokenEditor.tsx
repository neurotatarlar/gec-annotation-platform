/**
 * Interactive token editor UI for creating, moving, deleting, and editing corrections.
 * Coordinates selection, drag-and-drop, hotkeys, and error type badges while rendering token
 * groups. Acts as the view layer over TokenEditorModel state and related hooks.
 */
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { ErrorType, SaveStatus } from "../types";
import { useAnnotationDecisionActions } from "../hooks/useAnnotationDecisionActions";
import { useAnnotationInitialization } from "../hooks/useAnnotationInitialization";
import { useAnnotationPayloadBuilders } from "../hooks/useAnnotationPayloadBuilders";
import { useAnnotationSubmitAction } from "../hooks/useAnnotationSubmitAction";
import { useCorrectionAutopick } from "../hooks/useCorrectionAutopick";
import { useCorrectionSelection } from "../hooks/useCorrectionSelection";
import { useCorrectionTypes } from "../hooks/useCorrectionTypes";
import { useEditorUIState } from "../hooks/useEditorUIState";
import { useAnnotationsLoader } from "../hooks/useAnnotationsLoader";
import { useRenderController } from "../hooks/useRenderController";
import { useSaveController } from "../hooks/useSaveController";
import { useErrorTypes } from "../hooks/useErrorTypes";
import { useErrorTypeHotkeys } from "../hooks/useErrorTypeHotkeys";
import { useTokenEditorCommands } from "../hooks/useTokenEditorCommands";
import { useTokenEditorKeyboardShortcuts } from "../hooks/useTokenEditorKeyboardShortcuts";
import { useTokenInlineEdit } from "../hooks/useTokenInlineEdit";
import {
  DEFAULT_TOKEN_FONT_SIZE,
  DEFAULT_TOKEN_GAP,
  MAX_TOKEN_GAP,
  MIN_TOKEN_GAP,
  useTokenEditorPrefs,
} from "../hooks/useTokenEditorPrefs";
import { useTokenDragDrop } from "../hooks/useTokenDragDrop";
import { useTokenDeleteRange } from "../hooks/useTokenDeleteRange";
import { useTokenSelectionHandlers } from "../hooks/useTokenSelectionHandlers";
import {
  groupErrorTypes,
  sortActiveErrorTypes,
} from "../utils/errorTypes";
import { TokenEditorErrorTypePanel } from "./TokenEditorErrorTypePanel";
import { buildMoveLine, MoveLine } from "./TokenEditorMoveLine";
import { TokenEditorToken } from "./TokenEditorToken";
import { TokenEditorTokenGroups } from "./TokenEditorTokenGroups";
import {
  MoveMarker,
  Token,
  buildLineBreakMetadata,
  computeLineBreaksFromText,
  explicitLineBreaks,
  deriveLineStartIndices,
  buildTextFromTokensWithBreaks,
  deriveCorrectionByIndex,
  deriveCorrectionCards,
  deriveMoveMarkers,
  hasUnassignedSubmitCorrections,
  rangeToArray,
  tokenEditorReducer,
} from "./TokenEditorModel";
import { SpaceMarker } from "./TokenEditorSpacing";
import {
  isEditorStateStorageEnabled,
} from "./TokenEditorStorage";
import {
  actionBarStyle,
  actionDividerStyle,
  actionFeedbackStyle,
  actionGroupStyle,
  dangerActionStyle,
  mainColumnStyle,
  miniNeutralButton,
  miniOutlineButton,
  modalContentStyle,
  modalOverlayStyle,
  pageStyle,
  primaryActionStyle,
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
  const {
    tokenGap,
    setTokenGap,
    tokenFontSize,
    setTokenFontSize,
    spaceMarker,
    setSpaceMarker,
    viewTab,
    setViewTab,
    isTextPanelOpen,
    setIsTextPanelOpen,
    lastDecision,
    setLastDecision,
  } = useTokenEditorPrefs(textId);
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
  const [moveLine, setMoveLine] = useState<MoveLine | null>(null);
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
  const [hasLoadedAnnotations, setHasLoadedAnnotations] = useState(false);
  const lineBreaks = useMemo(
    () => explicitLineBreaks(history.present.tokens) ?? computeLineBreaksFromText(initialText),
    [initialText, history.present.tokens]
  );
  const { lineBreakCountMap } = useMemo(
    () => buildLineBreakMetadata(lineBreaks),
    [lineBreaks]
  );
  const [serverAnnotationVersion, setServerAnnotationVersion] = useState(0);
  const annotationIdMap = useRef<Map<string, number>>(new Map());
  const annotationDeleteMap = useRef<Map<string, number[]>>(new Map());
  const {
    lastSavedSignatureRef,
    pendingLocalStateRef,
    hydratedFromServerRef,
    hydrateFromServerAnnotations,
  } = useAnnotationInitialization({
    textId,
    initialText,
    currentUserId,
    dispatch,
    resetUI,
    setServerAnnotationVersion,
    setHasLoadedAnnotations,
  });

  const handleRevert = (rangeStart: number, rangeEnd: number) => {
    markSkipAutoSelect();
    setPendingSelectIndex(rangeStart);
    dispatch({ type: "REVERT_CORRECTION", rangeStart, rangeEnd });
    setSelection({ start: null, end: null });
    endEdit();
  };

  const tokens = history.present.tokens;
  const originalTokens = history.present.originalTokens;
  const lineStartIndices = useMemo(
    () => deriveLineStartIndices(tokens, lineBreaks),
    [tokens, lineBreaks]
  );
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
    () => sortActiveErrorTypes(errorTypes),
    [errorTypes]
  );

  const groupedErrorTypes = useMemo(
    () => groupErrorTypes(activeErrorTypes, locale, t("tokenEditor.categories")),
    [activeErrorTypes, locale, t]
  );

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
    setMoveLine(buildMoveLine(containerRect, srcRect, dstRect));
  }, [hoveredMoveId, moveMarkerById]);
  const correctionCards = useMemo(
    () => deriveCorrectionCards(tokens, moveMarkers),
    [tokens, moveMarkers]
  );
  const { defaultTypeForCard } = useCorrectionAutopick({
    errorTypes,
    correctionCards,
    moveMarkers,
    tokens,
    locale,
  });

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
    allowPendingLocalStateFallback: isEditorStateStorageEnabled(),
    onLoaded: () => setHasLoadedAnnotations(true),
  });

  const {
    requestNextText,
    handleFlag,
    confirmFlag,
    cancelFlag,
    isSkipping,
    isTrashing,
    actionMessage,
    setActionMessage,
    actionError,
    setActionError,
  } = useAnnotationDecisionActions({
    textId,
    categoryId,
    get,
    post,
    navigate,
    queryClient,
    t,
    formatError,
    pendingAction,
    flagReason,
    openFlagConfirm,
    closeFlagConfirm,
    updateFlagError,
    setLastDecision,
  });

  const { beginEdit, commitEdit, cancelEdit } = useTokenInlineEdit({
    tokens,
    hasSelection,
    selection,
    editingRange,
    editText,
    editInputRef,
    suppressBlurCommitRef,
    startEdit,
    endEdit,
    setSelection,
    setPendingSelectIndex,
    editSelectedRangeAsText: (range, newText) =>
      dispatch({ type: "EDIT_SELECTED_RANGE_AS_TEXT", range, newText }),
    cancelInsertPlaceholder: (range) => dispatch({ type: "CANCEL_INSERT_PLACEHOLDER", range }),
  });

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

  const {
    performUndo,
    performRedo,
    handleDeleteSelection,
    handleInsertBeforeSelection,
    handleInsertAfterSelection,
    handleMergeSelection,
  } = useTokenEditorCommands({
    editingRange,
    selection,
    selectedCount: selectedIndices.length,
    hasSelectionTokens: hasSelection,
    selectionRef,
    editInputRef,
    suppressBlurCommitRef,
    cancelEdit,
    markSkipAutoSelect,
    getDeleteRange,
    setSelection,
    startEdit,
    undo: () => dispatch({ type: "UNDO" }),
    redo: () => dispatch({ type: "REDO" }),
    deleteSelectedTokens: (ctx) =>
      dispatch({ type: "DELETE_SELECTED_TOKENS", range: ctx.range, anchorIndex: ctx.anchorIndex }),
    insertBeforeSelectedTokens: (range) => dispatch({ type: "INSERT_TOKEN_BEFORE_SELECTED", range }),
    insertAfterSelectedTokens: (range) => dispatch({ type: "INSERT_TOKEN_AFTER_SELECTED", range }),
    mergeRange: (range) => dispatch({ type: "MERGE_RANGE", range }),
  });

  useTokenEditorKeyboardShortcuts({
    editingRange,
    editText,
    selectionRef,
    editInputRef,
    suppressBlurCommitRef,
    showClearConfirm,
    pendingAction,
    performUndo,
    performRedo,
    cancelEdit,
    commitEdit,
    beginEdit,
    cancelFlag,
    closeClearConfirm,
    getDeleteRange,
    deleteSelectedTokens: (ctx) =>
      dispatch({ type: "DELETE_SELECTED_TOKENS", range: ctx.range, anchorIndex: ctx.anchorIndex }),
    insertAfterSelectedTokens: (range) => dispatch({ type: "INSERT_TOKEN_AFTER_SELECTED", range }),
    setSelection,
    startEdit,
  });

  const renderToken = (token: Token, index: number, forceChanged = false) => (
    <TokenEditorToken
      key={forceChanged ? `${token.id}-forced` : token.id}
      token={token}
      index={index}
      forceChanged={forceChanged}
      isSelected={selectedSet.has(index)}
      editingRange={editingRange}
      tokens={tokens}
      tokenFontSize={tokenFontSize}
      editText={editText}
      editInputRef={editInputRef}
      suppressBlurCommitRef={suppressBlurCommitRef}
      t={t}
      measureTextWidth={measureTextWidth}
      updateEditText={updateEditText}
      commitEdit={commitEdit}
      cancelEdit={cancelEdit}
      setSelection={setSelection}
      beginEdit={beginEdit}
      handleDragStart={handleDragStart}
      handleDragOverToken={handleDragOverToken}
      handleDropAt={handleDropAt}
      handleDragEnd={handleDragEnd}
      handleTokenClick={handleTokenClick}
      setTokenRef={(tokenId, el) => {
        tokenRefs.current[tokenId] = el;
      }}
    />
  );

  // Render tokens grouped by groupId so corrected clusters share one border and centered history.
  const renderTokenGroups = (tokenList: Token[]) => (
    <TokenEditorTokenGroups
      tokens={tokenList}
      tokenGap={tokenGap}
      tokenFontSize={tokenFontSize}
      spaceMarker={spaceMarker}
      isEditing={Boolean(editingRange)}
      lineStartIndices={lineStartIndices}
      lineBreakCountMap={lineBreakCountMap}
      dropIndex={dropIndex}
      moveIndexToId={moveIndexToId}
      moveMarkerById={moveMarkerById}
      hoveredMoveId={hoveredMoveId}
      correctionByIndex={correctionByIndex}
      correctionTypeMap={correctionTypeMap}
      errorTypeById={errorTypeById}
      locale={locale}
      t={t}
      measureTextWidth={measureTextWidth}
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
      setGroupRef={(groupKey, el) => {
        groupRefs.current[groupKey] = el;
      }}
    />
  );

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

  const {
    buildAnnotationsPayload,
    buildRenderPayload,
    buildSubmitCorrections,
  } = useAnnotationPayloadBuilders({
    initialText,
    tokens,
    originalTokens,
    correctionCards,
    correctionTypeMap,
    moveMarkers,
    annotationIdMap,
    annotationDeleteMap,
  });

  const localCorrectedText = useMemo(
    () => buildTextFromTokensWithBreaks(tokens, lineBreaks),
    [tokens, lineBreaks]
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
    expectedTargetText: localCorrectedText,
  });

  const { handleSubmit, isSubmitting } = useAnnotationSubmitAction({
    textId,
    buildSubmitCorrections,
    saveAnnotations,
    post,
    requestNextText,
    setLastDecision,
    setActionError,
    setActionMessage,
    formatError,
  });

  const {
    correctedText,
    isRenderPending,
    hasCanonicalRender,
  } = useRenderController({
    textId,
    resetKey: textId,
    tokensLength: tokens.length,
    correctionCount: correctionCards.length,
    hasLoadedAnnotations,
    localCorrectedText,
    buildRenderPayload,
    post,
  });
  const showCorrectedSpinner =
    viewTab === "corrected" && (!hasLoadedAnnotations || (isRenderPending && !hasCanonicalRender));

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

  useErrorTypeHotkeys(errorTypes, handleTypePick);

  const hasUnassignedCorrections = useMemo(
    () => hasUnassignedSubmitCorrections(correctionCards.map((card) => card.id), correctionTypeMap),
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
                {toolbarButton(t("tokenEditor.delete"), handleDeleteSelection, !hasSelectionTokens, "Del", "🗑️")}
                {toolbarButton(t("tokenEditor.insertBefore"), handleInsertBeforeSelection, !hasSelectionTokens, undefined, "➕")}
                {toolbarButton(t("tokenEditor.insertAfter"), handleInsertAfterSelection, !hasSelectionTokens, "Insert", "➕")}
                {toolbarButton(t("tokenEditor.merge"), handleMergeSelection, !hasSelectionTokens || selectedIndices.length < 2, undefined, "🔗")}
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
          renderTokenGroups={renderTokenGroups}
          rowRef={tokenRowRef}
          moveLine={moveLine}
          showSpinner={isRenderPending}
          onDragOver={handleRowDragOver}
          onDrop={handleRowDrop}
        />
        <TokenEditorErrorTypePanel
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
  renderTokenGroups: (tokens: Token[]) => React.ReactNode;
  rowRef: React.RefObject<HTMLDivElement>;
  moveLine: MoveLine | null;
  showSpinner?: boolean;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
};

const TokenRow: React.FC<TokenRowProps> = ({
  tokens,
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

// ---------------------------
// Styles
// ---------------------------
