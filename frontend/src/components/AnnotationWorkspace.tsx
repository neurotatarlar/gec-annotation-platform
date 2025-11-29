import clsx from "clsx";
import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../context/I18nContext";
import { ErrorTypePalette } from "./ErrorTypePalette";
import {
  BaseToken,
  CorrectionDraftV2,
  DraftTokenFragment,
  ErrorType,
  TokenId
} from "../types";
import { generateId } from "../utils/id";
import { tokenizeText } from "../utils/tokenize";
import { getErrorTypeLabel } from "../utils/errorTypes";

type VisualToken = DraftTokenFragment & {
  ownerCorrectionId: string | null;
  trace: TokenId[];
};

interface AnnotationWorkspaceProps {
  baseTokens: BaseToken[];
  corrections: CorrectionDraftV2[];
  activeCorrectionId: string | null;
  activeErrorTypeId: number | null;
  errorTypes: ErrorType[];
  onCreateCorrection: (tokenIds: TokenId[]) => CorrectionDraftV2 | null;
  onSelectCorrection: (correctionId: string | null) => void;
  onSelectErrorType: (id: number) => void;
  onUpdateCorrection: (correctionId: string, updater: (draft: CorrectionDraftV2) => CorrectionDraftV2) => void;
  onRemoveCorrection: (correctionId: string) => void;
  onResetCorrections: () => void;
}

type SelectionState = {
  start: number | null;
  end: number | null;
  activeEdge: "start" | "end";
};

const EMPTY_SELECTION: SelectionState = { start: null, end: null, activeEdge: "end" };

export const AnnotationWorkspace = ({
  baseTokens,
  corrections,
  activeCorrectionId,
  activeErrorTypeId,
  errorTypes,
  onCreateCorrection,
  onSelectCorrection,
  onSelectErrorType,
  onUpdateCorrection,
  onRemoveCorrection,
  onResetCorrections
}: AnnotationWorkspaceProps) => {
  const { t, locale } = useI18n();
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [hasFocus, setHasFocus] = useState(false);

  const baseTokenMap = useMemo(() => new Map(baseTokens.map((token) => [token.id, token])), [baseTokens]);

  const activeCorrection = corrections.find((item) => item.id === activeCorrectionId) ?? null;

  const selectedIndices = useMemo(() => {
    if (selection.start === null || selection.end === null) return [];
    const start = Math.max(0, Math.min(selection.start, selection.end));
    const end = Math.max(selection.start, selection.end);
    const indices: number[] = [];
    for (let i = start; i <= end; i += 1) {
      indices.push(i);
    }
    return indices;
  }, [selection]);

  const selectedTokenIds = useMemo(
    () => selectedIndices.map((index) => baseTokens[index]?.id).filter((id): id is string => Boolean(id)),
    [baseTokens, selectedIndices]
  );

  const clampIndex = useCallback(
    (value: number) => {
      if (!baseTokens.length) return -1;
      return Math.min(Math.max(value, 0), baseTokens.length - 1);
    },
    [baseTokens.length]
  );

  const getTokenIdsForRange = useCallback(
    (start: number, end: number): TokenId[] => {
      const ids: TokenId[] = [];
      for (let index = start; index <= end; index += 1) {
        const token = baseTokens[index];
        if (token) {
          ids.push(token.id);
        }
      }
      return ids;
    },
    [baseTokens]
  );

  const getTokenTextsForRange = useCallback(
    (start: number, end: number): string[] => {
      const texts: string[] = [];
      for (let index = start; index <= end; index += 1) {
        const token = baseTokens[index];
        if (token) {
          texts.push(token.text);
        }
      }
      return texts;
    },
    [baseTokens]
  );

  const setSelectionState = useCallback(
    (updater: SelectionState | ((prev: SelectionState) => SelectionState)) => {
      setSelection((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        if (next.start !== null && next.end !== null) {
          const focus = next.activeEdge === "start" ? next.start : next.end;
          setFocusIndex(clampIndex(focus));
        }
        return next;
      });
    },
    [clampIndex]
  );

  const errorTypeColor = useCallback(
    (errorTypeId: number | null) => {
      if (!errorTypeId) return "#14b8a6";
      return errorTypes.find((type) => type.id === errorTypeId)?.default_color ?? "#14b8a6";
    },
    [errorTypes]
  );

  const correctionMeta = useMemo(() => {
    const map = new Map<
      string,
      {
        color: string;
        label: string;
      }
    >();
    corrections.forEach((correction) => {
      const errorType = errorTypes.find((type) => type.id === correction.errorTypeId);
      map.set(correction.id, {
        color: errorTypeColor(correction.errorTypeId),
        label: errorType ? getErrorTypeLabel(errorType, locale) : t("annotation.untagged"),
      });
    });
    return map;
  }, [corrections, errorTypeColor, errorTypes, locale, t]);

  const correctedLine = useMemo(
    () => buildCorrectedLine(baseTokens, corrections),
    [baseTokens, corrections]
  );
  const sequenceSegments = useMemo(
    () => buildDisplaySegments(correctedLine, baseTokenMap, corrections),
    [correctedLine, baseTokenMap, corrections]
  );
  const ownerByIndex = useMemo(() => {
    const map = new Map<number, string | null>();
    sequenceSegments.forEach((segment) => {
      segment.indices.forEach((index) => {
        map.set(index, segment.ownerCorrectionId);
      });
    });
    return map;
  }, [sequenceSegments]);
  const [inlineEditor, setInlineEditor] = useState<{ correctionId: string; text: string } | null>(null);

  useEffect(() => {
    if (!baseTokens.length) {
      setFocusIndex(null);
      setSelection(EMPTY_SELECTION);
      return;
    }
    setFocusIndex((prev) => {
      if (prev === null) return 0;
      return clampIndex(prev);
    });
    setSelection((prev) => {
      if (prev.start === null || prev.end === null) {
        return prev;
      }
      return {
        ...prev,
        start: clampIndex(prev.start),
        end: clampIndex(prev.end)
      };
    });
  }, [baseTokens, clampIndex]);

  const clearSelection = useCallback(() => setSelectionState(EMPTY_SELECTION), [setSelectionState]);

  const handleRangeClick = (rangeStart: number | null, rangeEnd: number | null, useModifier: boolean) => {
    if (rangeStart === null || rangeEnd === null) return;
    const start = Math.min(rangeStart, rangeEnd);
    const end = Math.max(rangeStart, rangeEnd);
    if (!useModifier) {
      setSelectionState({ start, end, activeEdge: "end" });
      return;
    }
    setSelectionState((prev) => {
      if (prev.start === null || prev.end === null) {
        return { start, end, activeEdge: "end" };
      }
      const prevStart = Math.min(prev.start, prev.end);
      const prevEnd = Math.max(prev.start, prev.end);
      if (end < prevStart) {
        return { start, end: prevEnd, activeEdge: "end" };
      }
      if (start > prevEnd) {
        return { start: prevStart, end, activeEdge: "end" };
      }
      const center = (start + end) / 2;
      const distToStart = Math.abs(center - prevStart);
      const distToEnd = Math.abs(prevEnd - center);
      if (distToStart > distToEnd) {
        return { start: prevStart, end: Math.max(end, prevStart), activeEdge: "end" };
      }
      return { start: Math.min(start, prevEnd), end: prevEnd, activeEdge: "end" };
    });
  };

  const getOwnerForRange = useCallback(
    (start: number, end: number) => {
      let owner: string | null | undefined = undefined;
      for (let index = start; index <= end; index += 1) {
        const currentOwner = ownerByIndex.get(index) ?? null;
        if (owner === undefined) {
          owner = currentOwner;
          continue;
        }
        if (owner !== currentOwner) {
          return null;
        }
      }
      return owner ?? null;
    },
    [ownerByIndex]
  );

  const findCorrectionByTokenIds = useCallback(
    (tokenIds: TokenId[]) => {
      return corrections.find((correction) => areArraysEqual(correction.beforeTokens, tokenIds)) ?? null;
    },
    [corrections]
  );

  const ensureCorrectionForRange = useCallback(
    (start: number, end: number) => {
      const tokenIds = getTokenIdsForRange(start, end);
      if (!tokenIds.length) return null;
      const existing = findCorrectionByTokenIds(tokenIds);
      if (existing) {
        return existing;
      }
      return onCreateCorrection(tokenIds);
    },
    [findCorrectionByTokenIds, getTokenIdsForRange, onCreateCorrection]
  );

  const beginInlineEdit = useCallback(
    (rangeStart: number, rangeEnd: number, ownerCorrectionId: string | null) => {
      let correction: CorrectionDraftV2 | null = null;
      if (ownerCorrectionId) {
        correction = corrections.find((item) => item.id === ownerCorrectionId) ?? null;
      } else {
        correction = ensureCorrectionForRange(rangeStart, rangeEnd);
      }
      if (!correction) return;
      onSelectCorrection(correction.id);
      const textValue =
        correction.afterTokens.length === 1 && correction.afterTokens[0].text === "<EMPTY>"
          ? ""
          : correction.afterTokens.map((token) => token.text).join(" ").trim();
      setInlineEditor({
        correctionId: correction.id,
        text: textValue
      });
    },
    [corrections, ensureCorrectionForRange, onSelectCorrection]
  );

  const beginInlineEditForSelection = useCallback(() => {
    if (!selectedIndices.length) return;
    const start = selectedIndices[0];
    const end = selectedIndices[selectedIndices.length - 1];
    const owner = getOwnerForRange(start, end);
    beginInlineEdit(start, end, owner);
  }, [beginInlineEdit, getOwnerForRange, selectedIndices]);

  const applyDeletionToSelection = useCallback(() => {
    if (!selectedIndices.length) return;
    const start = selectedIndices[0];
    const end = selectedIndices[selectedIndices.length - 1];
    const correction = ensureCorrectionForRange(start, end);
    if (!correction) return;
    onUpdateCorrection(correction.id, (draft) => ({
      ...draft,
      afterTokens: [createEmptyTokenFragment()]
    }));
    onSelectCorrection(correction.id);
    setInlineEditor(null);
  }, [ensureCorrectionForRange, onSelectCorrection, onUpdateCorrection, selectedIndices]);

  const handleInsertAction = useCallback(() => {
    if (!selectedIndices.length) return;
    const start = selectedIndices[0];
    const end = selectedIndices[selectedIndices.length - 1];
    const correction = ensureCorrectionForRange(start, end);
    if (!correction) return;
    onUpdateCorrection(correction.id, (draft) => ({
      ...draft,
      afterTokens: [createEmptyTokenFragment()]
    }));
    setInlineEditor({ correctionId: correction.id, text: "" });
    onSelectCorrection(correction.id);
  }, [ensureCorrectionForRange, onSelectCorrection, onUpdateCorrection, selectedIndices]);

  const handleMergeSelection = useCallback(() => {
    if (selectedIndices.length < 2) return;
    const start = selectedIndices[0];
    const end = selectedIndices[selectedIndices.length - 1];
    const correction = ensureCorrectionForRange(start, end);
    if (!correction) return;
    const existingText = correction.afterTokens.length
      ? correction.afterTokens.map((token) => token.text).join(" ").trim()
      : getTokenTextsForRange(start, end).join(" ").trim();
    onUpdateCorrection(correction.id, (draft) => ({
      ...draft,
      afterTokens: [createInsertedToken(existingText)]
    }));
    onSelectCorrection(correction.id);
  }, [ensureCorrectionForRange, getTokenTextsForRange, onSelectCorrection, onUpdateCorrection, selectedIndices]);

  const handleSidebarEdit = useCallback(
    (correctionId: string) => {
      const segment = sequenceSegments.find((item) => item.ownerCorrectionId === correctionId);
      const indices = segment?.indices ?? [];
      const correction = corrections.find((item) => item.id === correctionId);
      const baseIndices =
        correction?.beforeTokens
          .map((tokenId) => baseTokenMap.get(tokenId)?.index)
          .filter((value): value is number => typeof value === "number") ?? [];
      const resolvedIndices = indices.length ? indices : baseIndices;
      if (!resolvedIndices.length) return;
      const startIdx = Math.min(...resolvedIndices);
      const endIdx = Math.max(...resolvedIndices);
      setSelectionState({ start: startIdx, end: endIdx, activeEdge: "end" });
      beginInlineEdit(startIdx, endIdx, correctionId);
    },
    [baseTokenMap, beginInlineEdit, corrections, sequenceSegments, setSelectionState]
  );

  const handleDiscardAll = useCallback(() => {
    onResetCorrections();
    clearSelection();
    setInlineEditor(null);
  }, [clearSelection, onResetCorrections, setInlineEditor]);

  useEffect(() => {
    if (!inlineEditor) return;
    const exists = corrections.some((correction) => correction.id === inlineEditor.correctionId);
    if (!exists) {
      setInlineEditor(null);
    }
  }, [corrections, inlineEditor]);

  const updateInlineEditorText = useCallback((value: string) => {
    setInlineEditor((prev) => (prev ? { ...prev, text: value } : prev));
  }, []);

  const commitInlineEditor = useCallback(() => {
    if (!inlineEditor) return;
    const fragments = buildFragmentsFromInput(inlineEditor.text);
    onUpdateCorrection(inlineEditor.correctionId, (draft) => ({
      ...draft,
      afterTokens: fragments
    }));
    setInlineEditor(null);
  }, [inlineEditor, onUpdateCorrection]);

  const cancelInlineEditor = useCallback(() => {
    setInlineEditor(null);
  }, []);

  const moveFocus = useCallback(
    (direction: -1 | 1) => {
      if (!baseTokens.length) return;
      const hasRange =
        selection.start !== null &&
        selection.end !== null &&
        selection.start !== selection.end;
      if (hasRange && selection.start !== null && selection.end !== null) {
        const boundary = direction > 0 ? selection.end : selection.start;
        const candidate = clampIndex(boundary + direction);
        if (candidate === boundary) return;
        setSelectionState({ start: candidate, end: candidate, activeEdge: "end" });
        return;
      }
      const origin =
        focusIndex !== null ? focusIndex : direction > 0 ? -1 : baseTokens.length;
      const next = clampIndex(origin + direction);
      if (next === origin || next === -1) return;
      setSelectionState({ start: next, end: next, activeEdge: "end" });
    },
    [baseTokens.length, clampIndex, focusIndex, selection.end, selection.start, setSelectionState]
  );

  const updateSelectionWithCtrlArrow = useCallback(
    (direction: -1 | 1) => {
      if (!baseTokens.length) return;
      setSelectionState((prev) => {
        if (prev.start === null || prev.end === null) {
          const origin = focusIndex ?? clampIndex(direction > 0 ? 0 : baseTokens.length - 1);
          const target = clampIndex(origin + direction);
          if (origin === target) {
            return prev;
          }
          return {
            start: Math.min(origin, target),
            end: Math.max(origin, target),
            activeEdge: direction < 0 ? "start" : "end"
          };
        }
        if (prev.start === prev.end) {
          const next = clampIndex(direction < 0 ? prev.start - 1 : prev.end + 1);
          if (next === prev.start) {
            return prev;
          }
          return {
            start: Math.min(prev.start, next),
            end: Math.max(prev.start, next),
            activeEdge: direction < 0 ? "start" : "end"
          };
        }
        if (prev.activeEdge === "start") {
          const next = clampIndex(prev.start + direction);
          if (direction < 0 && next === prev.start) {
            return prev;
          }
          if (direction > 0 && next > prev.end) {
            return prev;
          }
          return {
            start: Math.min(next, prev.end),
            end: prev.end,
            activeEdge: next <= prev.end ? "start" : "end"
          };
        }
        const next = clampIndex(prev.end + direction);
        if (direction > 0 && next === prev.end) {
          return prev;
        }
        if (direction < 0 && next < prev.start) {
          return prev;
        }
        return {
          start: prev.start,
          end: Math.max(prev.start, next),
          activeEdge: next >= prev.start ? "end" : "start"
        };
      });
    },
    [baseTokens.length, clampIndex, focusIndex, setSelectionState]
  );

  const handleCreateCorrection = useCallback(() => {
    if (!selectedTokenIds.length || !baseTokens.length) return;
    const existing = findCorrectionByTokenIds(selectedTokenIds);
    if (existing) {
      onSelectCorrection(existing.id);
      clearSelection();
      return;
    }
    const created = onCreateCorrection(selectedTokenIds);
    if (created) {
      onSelectCorrection(created.id);
      clearSelection();
    }
  }, [selectedTokenIds, baseTokens.length, onCreateCorrection, clearSelection, findCorrectionByTokenIds, onSelectCorrection]);

  useEffect(() => {
    const handleKeys = (event: KeyboardEvent) => {
      if (!hasFocus) return;
      if (inlineEditor) {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelInlineEditor();
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          commitInlineEditor();
        }
        return;
      }
      if (event.key === "Enter") {
        if (selectedTokenIds.length) {
          event.preventDefault();
          beginInlineEditForSelection();
          return;
        }
        if (!selectedTokenIds.length && !activeCorrectionId && baseTokens.length) {
          event.preventDefault();
          setSelectionState({
            start: 0,
            end: 0,
            activeEdge: "end"
          });
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        clearSelection();
        onSelectCorrection(null);
        return;
      }
      if (event.key === "Delete") {
        event.preventDefault();
        applyDeletionToSelection();
        return;
      }
      if (event.key === "Insert") {
        event.preventDefault();
        handleInsertAction();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        if (event.ctrlKey || event.metaKey) {
          updateSelectionWithCtrlArrow(direction);
        } else {
          moveFocus(direction);
        }
      }
    };
    window.addEventListener("keydown", handleKeys);
    return () => window.removeEventListener("keydown", handleKeys);
  }, [
    hasFocus,
    inlineEditor,
    selectedTokenIds.length,
    activeCorrectionId,
    baseTokens.length,
    onSelectCorrection,
    beginInlineEditForSelection,
    clearSelection,
    applyDeletionToSelection,
    handleInsertAction,
    cancelInlineEditor,
    commitInlineEditor,
    moveFocus,
    updateSelectionWithCtrlArrow
  ]);

  return (
    <div
      ref={workspaceRef}
      tabIndex={0}
      className="grid gap-6 xl:grid-cols-[2fr,1fr] focus:outline-none"
      onFocus={() => setHasFocus(true)}
      onBlur={(event) => {
        if (!workspaceRef.current?.contains(event.relatedTarget as Node | null)) {
          setHasFocus(false);
        }
      }}
    >
      <div className="space-y-6">
        <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-4">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">{t("annotation.originalColumn")}</p>
              <h3 className="text-lg font-semibold text-slate-100">{t("annotation.baseTokensTitle")}</h3>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
              {selectedTokenIds.length > 0 ? (
                <span>{t("annotation.tokensSelected", { count: selectedTokenIds.length })}</span>
              ) : (
                <span>{t("annotation.selectPrompt")}</span>
              )}
              <button
                className="rounded-xl border border-emerald-500/60 px-3 py-1 text-sm font-semibold text-emerald-100 disabled:opacity-40"
                onClick={handleCreateCorrection}
                disabled={!selectedTokenIds.length}
                title={!activeErrorTypeId ? t("annotation.errorTypeHint") : ""}
              >
                {t("annotation.createCorrection")}
              </button>
            </div>
          </header>

          <div className="mt-4 flex flex-wrap gap-2 text-sm">
            <ActionButton label="Insert (Ins)" onClick={handleInsertAction} disabled={!selectedIndices.length} />
            <ActionButton label="Delete (Del)" onClick={applyDeletionToSelection} disabled={!selectedIndices.length} />
            <ActionButton label="Merge" onClick={handleMergeSelection} disabled={selectedIndices.length < 2} />
          </div>

          <TokenSequence
            segments={sequenceSegments}
            selectedIndices={selectedIndices}
            focusIndex={focusIndex}
            correctionMeta={correctionMeta}
            onRangeClick={handleRangeClick}
            onEditRange={(start, end, owner) => beginInlineEdit(start, end, owner)}
            onRemoveRange={onRemoveCorrection}
            t={t}
          />

          {inlineEditor && (
            <InlineEditorPanel
              value={inlineEditor.text}
              onChange={updateInlineEditorText}
              onSave={commitInlineEditor}
              onCancel={cancelInlineEditor}
            />
          )}
        </div>

        <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-4">
          {activeCorrection ? (
            <ActiveCorrectionPanel
              baseTokens={baseTokens}
              correction={activeCorrection}
              errorTypes={errorTypes}
              onUpdate={(updater) => onUpdateCorrection(activeCorrection.id, updater)}
              onRemove={() => onRemoveCorrection(activeCorrection.id)}
            />
          ) : (
            <p className="rounded-2xl border border-dashed border-slate-800/80 px-4 py-3 text-sm text-slate-400">
              {t("annotation.pickCorrectionHint")}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-6">
        <ErrorTypePalette errorTypes={errorTypes} activeId={activeErrorTypeId} onSelect={onSelectErrorType} />
        <CorrectionsSidebar
          corrections={corrections}
          baseTokens={baseTokens}
          errorTypes={errorTypes}
          activeCorrectionId={activeCorrectionId}
          onSelectCorrection={onSelectCorrection}
          onEditCorrection={handleSidebarEdit}
          onRemoveCorrection={onRemoveCorrection}
          onDiscardAll={handleDiscardAll}
          t={t}
        />
      </div>
    </div>
  );
};

type SequenceSegment = {
  ownerCorrectionId: string | null;
  afterTokens: VisualToken[];
  baseTokens: BaseToken[];
  indices: number[];
};

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

const TokenSequence = ({
  segments,
  selectedIndices,
  focusIndex,
  correctionMeta,
  onRangeClick,
  onEditRange,
  onRemoveRange,
  t
}: {
  segments: SequenceSegment[];
  selectedIndices: number[];
  focusIndex: number | null;
  correctionMeta: Map<string, { color: string; label: string }>;
  onRangeClick: (start: number | null, end: number | null, useModifier: boolean) => void;
  onEditRange: (start: number, end: number, ownerCorrectionId: string | null) => void;
  onRemoveRange: (correctionId: string) => void;
  t: TranslateFn;
}) => {
  const selectionSet = useMemo(() => new Set(selectedIndices), [selectedIndices]);

  return (
    <div className="mt-4 flex flex-wrap gap-3 rounded-2xl border border-slate-800/70 bg-slate-950/40 p-3">
      {segments.map((segment, index) => {
        const rangeStart = segment.indices.length ? Math.min(...segment.indices) : null;
        const rangeEnd = segment.indices.length ? Math.max(...segment.indices) : null;
        const isSelected = segment.indices.some((idx) => selectionSet.has(idx));
        const isFocused = focusIndex !== null && segment.indices.includes(focusIndex);
        const key = segment.ownerCorrectionId ? `${segment.ownerCorrectionId}-${index}` : `base-${segment.indices[0] ?? index}`;
        const handleClick = (event: MouseEvent<HTMLDivElement>) => {
          if (rangeStart === null || rangeEnd === null) return;
          onRangeClick(rangeStart, rangeEnd, event.ctrlKey || event.metaKey);
        };
        const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
          event.preventDefault();
          if (rangeStart === null || rangeEnd === null) return;
          onEditRange(rangeStart, rangeEnd, segment.ownerCorrectionId ?? null);
        };

        if (!segment.ownerCorrectionId) {
          const tokenText = segment.afterTokens.map((token) => token.text).join(" ") || t("annotation.tokenEmpty");
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              className={clsx(
                "rounded-full px-3 py-1 text-sm transition",
                isSelected
                  ? "border border-emerald-400 bg-emerald-500/10 text-emerald-100"
                  : "border border-transparent bg-slate-800/40 text-slate-100 hover:border-slate-700",
                isFocused ? "ring-2 ring-emerald-300/70" : "ring-0"
              )}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
            >
              {tokenText}
            </div>
          );
        }

        const correctedText =
          segment.afterTokens.map((token) => token.text).join(" ").trim() || t("annotation.tokenEmpty");
        const originalText =
          segment.baseTokens.map((token) => token.text).join(" ").trim() || t("annotation.tokenEmpty");
        const meta = correctionMeta.get(segment.ownerCorrectionId);
        const color = meta?.color ?? "#22d3ee";
        const isEmptyPlaceholder = correctedText === "<EMPTY>";

        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            className={clsx(
              "relative w-full rounded-2xl px-4 py-3 text-right text-sm transition sm:w-auto",
              isSelected
                ? "border border-emerald-400 bg-emerald-500/15"
                : "border border-transparent bg-slate-800/40 hover:border-slate-700",
              isFocused ? "ring-2 ring-emerald-300/70" : "ring-0"
            )}
            style={{ backgroundColor: `${color}22`, borderColor: isSelected ? undefined : `${color}44` }}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
          >
            <button
              className="absolute left-2 top-2 rounded-full border border-rose-500/60 px-2 py-0.5 text-xs text-rose-100"
              onClick={(event) => {
                event.stopPropagation();
                if (segment.ownerCorrectionId) {
                  onRemoveRange(segment.ownerCorrectionId);
                }
              }}
            >
              ×
            </button>
            <span
              className={clsx(
                "block text-base font-semibold",
                isEmptyPlaceholder ? "italic text-emerald-300" : "text-emerald-100"
              )}
            >
              {isEmptyPlaceholder ? t("annotation.tokenEmpty") : correctedText}
            </span>
            <div className="mt-1 flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-rose-200">{originalText || t("annotation.tokenEmpty")}</span>
              <span className="text-[10px] uppercase tracking-wide text-rose-300">{meta?.label ?? t("annotation.untagged")}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const InlineEditorPanel = ({
  value,
  onChange,
  onSave,
  onCancel
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) => (
  <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-slate-900/60 p-4">
    <textarea
      className="mt-2 w-full rounded-xl border border-slate-700/70 bg-slate-950/70 p-3 text-sm text-slate-100"
      rows={3}
      value={value}
      autoFocus
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSave();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      placeholder="Type replacement tokens…"
    />
    <div className="mt-3 flex justify-end gap-2 text-sm">
      <button className="rounded-xl border border-slate-600 px-4 py-2 text-slate-200" onClick={onCancel}>
        Cancel
      </button>
      <button className="rounded-xl border border-emerald-500/70 bg-emerald-500/20 px-4 py-2 text-emerald-100" onClick={onSave}>
        Save
      </button>
    </div>
  </div>
);

const ActionButton = ({
  label,
  onClick,
  disabled
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) => (
  <button
    className="rounded-xl border border-slate-700/70 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-200 disabled:opacity-40"
    onClick={onClick}
    disabled={disabled}
  >
    {label}
  </button>
);

const CorrectionsSidebar = ({
  corrections,
  baseTokens,
  errorTypes,
  activeCorrectionId,
  onSelectCorrection,
  onEditCorrection,
  onRemoveCorrection,
  onDiscardAll,
  t
}: {
  corrections: CorrectionDraftV2[];
  baseTokens: BaseToken[];
  errorTypes: ErrorType[];
  activeCorrectionId: string | null;
  onSelectCorrection: (id: string) => void;
  onEditCorrection: (id: string) => void;
  onRemoveCorrection: (id: string) => void;
  onDiscardAll: () => void;
  t: TranslateFn;
}) => {
  const baseTokenMap = useMemo(() => new Map(baseTokens.map((token) => [token.id, token])), [baseTokens]);
  const localize = useCallback(
    (key: string, fallback: string, params?: Record<string, string | number>) => {
      const value = t(key, params);
      return value === key ? fallback : value;
    },
    [t]
  );
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 text-right">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-slate-100">{t("annotation.correctionsTitle")}</h3>
        <button
          className="rounded-xl border border-rose-500/60 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-rose-200 disabled:opacity-40"
          onClick={onDiscardAll}
          disabled={corrections.length === 0}
        >
          {localize("annotation.discardAll", "Discard All")}
        </button>
      </header>
      <p className="text-xs text-slate-400">
        {localize("annotation.sidebarCount", `${corrections.length} corrections`, { count: corrections.length })}
      </p>

      {corrections.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-dashed border-slate-700/70 px-4 py-3 text-sm text-slate-400">
          {t("annotation.correctionsEmpty")}
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {corrections.map((correction) => {
            const originalText = correction.beforeTokens
              .map((tokenId) => baseTokenMap.get(tokenId)?.text ?? "")
              .filter(Boolean)
              .join(" ")
              .trim();
            const correctedText =
              correction.afterTokens.map((token) => token.text).join(" ").trim() || t("annotation.tokenEmpty");
            const errorType = errorTypes.find((type) => type.id === correction.errorTypeId);
            const isActive = activeCorrectionId === correction.id;
            const label = errorType ? getErrorTypeLabel(errorType, locale) : t("annotation.untagged");
            return (
              <div
                key={correction.id}
                className={clsx(
                  "rounded-2xl border px-3 py-3 text-right text-sm transition",
                  isActive ? "border-emerald-400 bg-emerald-500/10" : "border-slate-800 bg-slate-900/60"
                )}
                role="button"
                tabIndex={0}
                onClick={() => onSelectCorrection(correction.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {label}
                  </span>
                  <div className="flex gap-2 text-xs">
                    <button
                      className="rounded-lg border border-slate-600 px-2 py-1 text-slate-200"
                      onClick={(event) => {
                        event.stopPropagation();
                        onEditCorrection(correction.id);
                      }}
                    >
                      {localize("annotation.editAction", "Edit")}
                    </button>
                    <button
                      className="rounded-lg border border-rose-500/60 px-2 py-1 text-rose-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveCorrection(correction.id);
                      }}
                    >
                      {localize("annotation.removeAction", "Remove")}
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-rose-200">{originalText || t("annotation.tokenEmpty")}</p>
                <p className="mt-1 text-sm font-semibold text-emerald-100">{correctedText}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

interface ActiveCorrectionPanelProps {
  baseTokens: BaseToken[];
  correction: CorrectionDraftV2;
  errorTypes: ErrorType[];
  onUpdate: (updater: (draft: CorrectionDraftV2) => CorrectionDraftV2) => void;
  onRemove: () => void;
}

const ActiveCorrectionPanel = ({ baseTokens, correction, errorTypes, onUpdate, onRemove }: ActiveCorrectionPanelProps) => {
  const { t, locale } = useI18n();
  const baseTokenMap = useMemo(() => new Map(baseTokens.map((token) => [token.id, token])), [baseTokens]);
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  useEffect(() => {
    if (editingTokenId && !correction.afterTokens.some((token) => token.id === editingTokenId)) {
      setEditingTokenId(null);
      setEditingValue("");
    }
  }, [correction.afterTokens, editingTokenId]);

  const updateAfterTokens = (updater: (tokens: DraftTokenFragment[]) => DraftTokenFragment[]) => {
    onUpdate((draft) => ({ ...draft, afterTokens: updater(draft.afterTokens) }));
  };

  const removeBeforeToken = (tokenIndex: number) => {
    onUpdate((draft) => ({
      ...draft,
      beforeTokens: draft.beforeTokens.filter((_, idx) => idx !== tokenIndex)
    }));
  };

  const moveBeforeToken = (tokenIndex: number, direction: -1 | 1) => {
    onUpdate((draft) => {
      const next = [...draft.beforeTokens];
      const target = tokenIndex + direction;
      if (target < 0 || target >= next.length) {
        return draft;
      }
      [next[tokenIndex], next[target]] = [next[target], next[tokenIndex]];
      return { ...draft, beforeTokens: next };
    });
  };

  const addInsertedToken = () => {
    updateAfterTokens((tokens) => [...tokens, createInsertedToken("")]);
  };

  const insertTokenAt = (index: number) => {
    updateAfterTokens((tokens) => {
      const next = [...tokens];
      next.splice(index, 0, createInsertedToken(""));
      return next;
    });
  };

  const updateTokenText = (tokenId: string, text: string) => {
    updateAfterTokens((tokens) => tokens.map((token) => (token.id === tokenId ? { ...token, text } : token)));
  };

  const removeToken = (tokenId: string) => {
    updateAfterTokens((tokens) => tokens.filter((token) => token.id !== tokenId));
  };

  const moveToken = (tokenId: string, direction: -1 | 1) => {
    updateAfterTokens((tokens) => {
      const currentIndex = tokens.findIndex((token) => token.id === tokenId);
      if (currentIndex === -1) return tokens;
      const target = currentIndex + direction;
      if (target < 0 || target >= tokens.length) return tokens;
      const next = [...tokens];
      [next[currentIndex], next[target]] = [next[target], next[currentIndex]];
      return next;
    });
  };

  const splitToken = (tokenId: string) => {
    updateAfterTokens((tokens) => {
      const index = tokens.findIndex((token) => token.id === tokenId);
      if (index === -1) return tokens;
      const current = tokens[index];
      const parts = tokenizeText(current.text);
      if (parts.length <= 1) return tokens;
      const fragments = parts.map((text) => createInsertedToken(text));
      const next = [...tokens];
      next.splice(index, 1, ...fragments);
      return next;
    });
  };

  const mergeWithNext = (tokenId: string) => {
    updateAfterTokens((tokens) => {
      const index = tokens.findIndex((token) => token.id === tokenId);
      if (index === -1 || index === tokens.length - 1) return tokens;
      const current = tokens[index];
      const neighbor = tokens[index + 1];
      const merged = `${current.text} ${neighbor.text}`.trim();
      const next = [...tokens];
      next.splice(index, 2, { ...current, id: generateId(), text: merged });
      return next;
    });
  };

  const startEditing = (tokenId: string, initial: string) => {
    setEditingTokenId(tokenId);
    setEditingValue(initial);
  };

  const commitEditing = () => {
    if (!editingTokenId) return;
    updateTokenText(editingTokenId, editingValue);
    setEditingTokenId(null);
    setEditingValue("");
  };

  const cancelEditing = () => {
    setEditingTokenId(null);
    setEditingValue("");
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase text-slate-400">{t("annotation.correctionsTitle")}</p>
          <select
            className="mt-1 rounded-xl border border-slate-600 bg-slate-800/80 px-3 py-2 text-sm text-slate-100"
            value={correction.errorTypeId ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              onUpdate((draft) => ({
                ...draft,
                errorTypeId: value ? Number(value) : null
              }));
            }}
          >
            <option value="">{t("annotation.selectPrompt")}</option>
            {errorTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {getErrorTypeLabel(type, locale)}
              </option>
            ))}
          </select>
        </div>
        <button className="rounded-xl border border-rose-500/70 px-3 py-2 text-sm text-rose-100" onClick={onRemove}>
            {t("sidebar.remove")}
          </button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr,1.2fr]">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">{t("annotation.originalColumn")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {correction.beforeTokens.map((tokenId, tokenIndex) => {
              const token = baseTokenMap.get(tokenId);
              if (!token) return null;
              return (
                <div
                  key={`${tokenId}-${tokenIndex}`}
                  className="group flex items-center gap-1 rounded-full border border-slate-700/70 bg-slate-900/70 px-3 py-1 text-sm text-slate-100"
                >
                  <span>{token.text}</span>
                  <div className="flex items-center gap-1 text-xs text-slate-300 opacity-0 transition group-hover:opacity-100">
                    <button onClick={() => moveBeforeToken(tokenIndex, -1)} title={t("annotation.moveLeft")}>
                      ←
                    </button>
                    <button onClick={() => moveBeforeToken(tokenIndex, 1)} title={t("annotation.moveRight")}>
                      →
                    </button>
                    <button onClick={() => removeBeforeToken(tokenIndex)} title={t("annotation.removeToken")}>
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
            {correction.beforeTokens.length === 0 && (
              <p className="rounded-xl border border-dashed border-slate-700/70 px-3 py-2 text-sm text-slate-400">
                {t("annotation.selectPrompt")}
              </p>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">{t("annotation.correctedColumn")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {correction.afterTokens.map((token, tokenIndex) => {
              const isEditing = editingTokenId === token.id;
              return (
                <div
                  key={token.id}
                  className="group flex items-center gap-2 rounded-full border border-slate-700/70 bg-slate-900/70 px-3 py-1 text-sm text-slate-100"
                >
                  {isEditing ? (
                    <input
                      className="max-w-[200px] rounded-md border border-emerald-500/60 bg-slate-900/80 px-2 py-1 text-sm text-slate-100 outline-none"
                      value={editingValue}
                      autoFocus
                      onChange={(event) => setEditingValue(event.target.value)}
                      onBlur={commitEditing}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitEditing();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelEditing();
                        }
                        if (event.key === "Backspace" && editingValue.length === 0) {
                          event.preventDefault();
                          removeToken(token.id);
                        }
                        if (event.shiftKey && event.key === "ArrowLeft") {
                          event.preventDefault();
                          moveToken(token.id, -1);
                        }
                        if (event.shiftKey && event.key === "ArrowRight") {
                          event.preventDefault();
                          moveToken(token.id, 1);
                        }
                      }}
                    />
                  ) : (
                    <button
                      className="max-w-[200px] truncate text-left"
                      onClick={() => startEditing(token.id, token.text)}
                      title={token.text}
                    >
                      {token.text.trim().length ? token.text : t("annotation.tokenEmpty")}
                    </button>
                  )}
                  <div className="flex items-center gap-1 text-xs text-slate-300 opacity-0 transition group-hover:opacity-100">
                    <button onClick={() => insertTokenAt(tokenIndex)} title={t("annotation.addToken")}>
                      +
                    </button>
                    <button onClick={() => splitToken(token.id)} title={t("annotation.splitToken")}>
                      |
                    </button>
                    <button
                      disabled={tokenIndex === correction.afterTokens.length - 1}
                      className="disabled:opacity-40"
                      onClick={() => mergeWithNext(token.id)}
                      title={t("annotation.mergeNext")}
                    >
                      ⇆
                    </button>
                    <button
                      disabled={tokenIndex === 0}
                      className="disabled:opacity-40"
                      onClick={() => moveToken(token.id, -1)}
                      title={t("annotation.moveLeft")}
                    >
                      ←
                    </button>
                    <button
                      disabled={tokenIndex === correction.afterTokens.length - 1}
                      className="disabled:opacity-40"
                      onClick={() => moveToken(token.id, 1)}
                      title={t("annotation.moveRight")}
                    >
                      →
                    </button>
                    <button onClick={() => removeToken(token.id)} title={t("annotation.removeToken")}>
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
            <button
              className="w-full rounded-xl border border-dashed border-emerald-500/50 px-3 py-2 text-sm text-emerald-200"
              onClick={addInsertedToken}
            >
              {t("annotation.addToken")}
            </button>
          </div>
        </div>
      </div>

      <div>
        <label className="text-xs uppercase tracking-wide text-slate-400">{t("annotation.noteLabel")}</label>
        <textarea
          className="mt-1 w-full rounded-xl border border-slate-700/70 bg-slate-900/80 px-3 py-2 text-sm text-slate-100"
          placeholder={t("annotation.noteLabel")}
          rows={2}
          value={correction.note ?? ""}
          onChange={(event) =>
            onUpdate((draft) => ({
              ...draft,
              note: event.target.value
            }))
          }
        />
      </div>
    </div>
  );
};

const buildCorrectedLine = (baseTokens: BaseToken[], corrections: CorrectionDraftV2[]): VisualToken[] => {
  let working: VisualToken[] = baseTokens.map((token) => ({
    id: token.id,
    text: token.text,
    origin: "base",
    sourceId: token.id,
    ownerCorrectionId: null,
    trace: [token.id]
  }));

  corrections.forEach((correction) => {
    const beforeSet = new Set(correction.beforeTokens);
    const indexes: number[] = [];
    working.forEach((fragment, index) => {
      if (fragment.trace.some((tokenId) => beforeSet.has(tokenId))) {
        indexes.push(index);
      }
    });

    const insertPosition = indexes.length ? indexes[0] : working.length;
    if (indexes.length) {
      for (let i = indexes.length - 1; i >= 0; i -= 1) {
        working.splice(indexes[i], 1);
      }
    }

    if (!correction.afterTokens.length) return;
    const fragments = correction.afterTokens.map((fragment) => ({
      ...fragment,
      id: fragment.id || generateId(),
      ownerCorrectionId: correction.id,
      trace: correction.beforeTokens.length ? [...correction.beforeTokens] : fragment.sourceId ? [fragment.sourceId] : [],
      sourceId: fragment.sourceId ?? null
    }));
    working.splice(insertPosition, 0, ...fragments);
  });

  return working;
};

const createInsertedToken = (text: string): DraftTokenFragment => ({
  id: generateId(),
  text,
  origin: "inserted",
  sourceId: null
});

const createEmptyTokenFragment = (): DraftTokenFragment => ({
  id: generateId(),
  text: "<EMPTY>",
  origin: "inserted",
  sourceId: null
});

const buildFragmentsFromInput = (input: string): DraftTokenFragment[] => {
  const trimmed = input.trim();
  if (!trimmed) {
    return [createEmptyTokenFragment()];
  }
  const parts = tokenizeText(input);
  if (!parts.length) {
    return [createEmptyTokenFragment()];
  }
  return parts.map((part) => createInsertedToken(part));
};

const buildDisplaySegments = (
  tokens: VisualToken[],
  baseTokenMap: Map<TokenId, BaseToken>,
  corrections: CorrectionDraftV2[]
): SequenceSegment[] => {
  const segments: SequenceSegment[] = [];
  const correctionMap = new Map(corrections.map((correction) => [correction.id, correction]));
  let currentOwner: string | null = null;
  let bucket: VisualToken[] = [];

  const flushBucket = () => {
    if (!bucket.length || !currentOwner) {
      bucket = [];
      currentOwner = null;
      return;
    }
    const correction = correctionMap.get(currentOwner) ?? null;
    let baseRefs =
      (correction?.beforeTokens ?? [])
        .map((tokenId) => baseTokenMap.get(tokenId))
        .filter((value): value is BaseToken => Boolean(value));
    if (!baseRefs.length) {
      const traceIds = Array.from(new Set(bucket.flatMap((token) => token.trace)));
      baseRefs = traceIds
        .map((tokenId) => baseTokenMap.get(tokenId))
        .filter((value): value is BaseToken => Boolean(value));
    }
    const indices = baseRefs
      .map((token) => token.index)
      .filter((index): index is number => typeof index === "number");
    segments.push({
      ownerCorrectionId: currentOwner,
      afterTokens: bucket,
      baseTokens: baseRefs,
      indices
    });
    bucket = [];
    currentOwner = null;
  };

  tokens.forEach((token) => {
    if (!token.ownerCorrectionId) {
      flushBucket();
      const baseRef = resolveBaseTokenReference(token, baseTokenMap);
      const indices = baseRef && typeof baseRef.index === "number" ? [baseRef.index] : [];
      segments.push({
        ownerCorrectionId: null,
        afterTokens: [token],
        baseTokens: baseRef ? [baseRef] : [],
        indices
      });
      return;
    }
    if (currentOwner !== token.ownerCorrectionId) {
      flushBucket();
      currentOwner = token.ownerCorrectionId;
      bucket = [token];
      return;
    }
    bucket.push(token);
  });

  flushBucket();

  return segments;
};

const resolveBaseTokenReference = (token: VisualToken, baseTokenMap: Map<TokenId, BaseToken>) => {
  for (const traceId of token.trace) {
    const base = baseTokenMap.get(traceId);
    if (base) return base;
  }
  if (token.sourceId) {
    const base = baseTokenMap.get(token.sourceId);
    if (base) return base;
  }
  return baseTokenMap.get(token.id) ?? null;
};

const areArraysEqual = (first: TokenId[], second: TokenId[]) => {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) {
      return false;
    }
  }
  return true;
};
