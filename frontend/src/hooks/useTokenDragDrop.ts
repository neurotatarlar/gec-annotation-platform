import { useCallback, useRef, useState } from "react";

import { buildEditableTextFromTokens, Token } from "../components/TokenEditorModel";

type SelectionRange = { start: number | null; end: number | null };
type DragRange = { start: number; end: number };
type GapLayout = {
  left: number;
  top: number;
  positions: Array<{ index: number; midX: number; midY: number }>;
};

type UseTokenDragDropArgs = {
  tokens: Token[];
  selection: SelectionRange;
  selectionRef: React.MutableRefObject<SelectionRange>;
  hasSelection: boolean;
  editingRange: SelectionRange | null;
  expandRangeToGroups: (start: number, end: number) => DragRange;
  setSelection: (range: SelectionRange) => void;
  updateGapPositions: () => void;
  gapLayoutRef: React.MutableRefObject<GapLayout>;
  dispatchMove: (payload: { fromStart: number; fromEnd: number; toIndex: number }) => void;
};

export const useTokenDragDrop = ({
  tokens,
  selection,
  selectionRef,
  hasSelection,
  editingRange,
  expandRangeToGroups,
  setSelection,
  updateGapPositions,
  gapLayoutRef,
  dispatchMove,
}: UseTokenDragDropArgs) => {
  const dragStateRef = useRef<DragRange | null>(null);
  const lastDragPointRef = useRef<{ x: number; y: number } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const pendingDropIndexRef = useRef<number | null>(null);
  const dropRafRef = useRef<number | null>(null);

  const resolveClientPoint = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const x = Number.isFinite(event.clientX) ? event.clientX : 0;
    const y = Number.isFinite(event.clientY) ? event.clientY : 0;
    if (!(x === 0 && y === 0)) return { x, y };
    const native = event.nativeEvent as MouseEvent | undefined;
    if (native && typeof native.offsetX === "number" && typeof native.offsetY === "number") {
      const rect = event.currentTarget.getBoundingClientRect();
      return { x: rect.left + native.offsetX, y: rect.top + native.offsetY };
    }
    return { x, y };
  }, []);

  const applyDropIndex = useCallback((index: number) => {
    pendingDropIndexRef.current = index;
    setDropIndex((prev) => (prev === index ? prev : index));
    if (dropRafRef.current === null) {
      dropRafRef.current = requestAnimationFrame(() => {
        dropRafRef.current = null;
        setDropIndex((prev) => (prev === pendingDropIndexRef.current ? prev : pendingDropIndexRef.current));
      });
    }
  }, []);

  const resolveDragRange = useCallback(() => {
    if (dragStateRef.current) return dragStateRef.current;
    const currentSelection = selectionRef.current;
    if (currentSelection.start === null || currentSelection.end === null) return null;
    return expandRangeToGroups(
      Math.min(currentSelection.start, currentSelection.end),
      Math.max(currentSelection.start, currentSelection.end)
    );
  }, [expandRangeToGroups, selectionRef]);

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
      let range: DragRange;
      if (
        hasSelection &&
        index >= Math.min(selection.start!, selection.end!) &&
        index <= Math.max(selection.start!, selection.end!)
      ) {
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
      updateGapPositions();
      lastDragPointRef.current = null;
      dragStateRef.current = range;
      setDropIndex(null);
      event.dataTransfer.setData("text/plain", "move");
      event.dataTransfer.effectAllowed = "move";
      const preview = document.createElement("div");
      preview.textContent = buildEditableTextFromTokens(slice);
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
    [
      editingRange,
      expandRangeToGroups,
      hasSelection,
      selection,
      setSelection,
      tokens,
      updateGapPositions,
    ]
  );

  const handleDragOverToken = useCallback(
    (index: number, event: React.DragEvent<HTMLDivElement>) => {
      if (!dragStateRef.current) {
        const range = expandRangeToGroups(index, index);
        dragStateRef.current = range;
        setSelection(range);
      }
      event.preventDefault();
      lastDragPointRef.current = resolveClientPoint(event);
      const rect = event.currentTarget.getBoundingClientRect();
      const isAfter = (event.clientX - rect.left) / Math.max(1, rect.width) > 0.5;
      const nextIndex = isAfter ? index + 1 : index;
      applyDropIndex(nextIndex);
    },
    [applyDropIndex, expandRangeToGroups, resolveClientPoint, setSelection]
  );

  const handleDragOverGap = useCallback(
    (index: number, event: React.DragEvent<HTMLDivElement>) => {
      if (!dragStateRef.current) return;
      event.preventDefault();
      lastDragPointRef.current = resolveClientPoint(event);
      applyDropIndex(index);
    },
    [applyDropIndex, resolveClientPoint]
  );

  const handleDropAt = useCallback(
    (index: number) => {
      const drag = resolveDragRange();
      dragStateRef.current = null;
      setDropIndex(null);
      if (!drag) return;
      dispatchMove({ fromStart: drag.start, fromEnd: drag.end, toIndex: index });
      setSelection({ start: null, end: null });
    },
    [dispatchMove, resolveDragRange, setSelection]
  );

  const getClosestDropIndex = useCallback(
    (clientX: number, clientY: number) => {
      if (!gapLayoutRef.current.positions.length) {
        updateGapPositions();
      }
      const { left, top, positions } = gapLayoutRef.current;
      if (!positions.length) return null;
      const x = clientX - left;
      const y = clientY - top;
      let closestIndex: number | null = null;
      let closestScore = Number.POSITIVE_INFINITY;
      positions.forEach((pos) => {
        const dx = x - pos.midX;
        const dy = y - pos.midY;
        const score = dx * dx + dy * dy * 4;
        if (score < closestScore) {
          closestScore = score;
          closestIndex = pos.index;
        }
      });
      return closestIndex;
    },
    [gapLayoutRef, updateGapPositions]
  );

  const getDropIndexFromTarget = useCallback((target: HTMLDivElement, point: { x: number; y: number }) => {
    const gaps = target.querySelectorAll<HTMLElement>("[data-drop-index]");
    let closestIndex: number | null = null;
    let closestScore = Number.POSITIVE_INFINITY;
    gaps.forEach((gap) => {
      const idx = Number(gap.dataset.dropIndex);
      if (Number.isNaN(idx)) return;
      const rect = gap.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const midY = rect.top + rect.height / 2;
      const dx = point.x - midX;
      const dy = point.y - midY;
      const score = dx * dx + dy * dy * 4;
      if (score < closestScore) {
        closestScore = score;
        closestIndex = idx;
      }
    });
    return closestIndex;
  }, []);

  const handleRowDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!dragStateRef.current) return;
      event.preventDefault();
      const point = resolveClientPoint(event);
      lastDragPointRef.current = point;
      const nextIndex = getClosestDropIndex(point.x, point.y);
      if (nextIndex !== null) {
        applyDropIndex(nextIndex);
      }
    },
    [applyDropIndex, getClosestDropIndex, resolveClientPoint]
  );

  const handleRowDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!dragStateRef.current) return;
      event.preventDefault();
      const point = resolveClientPoint(event);
      const fallbackPoint = lastDragPointRef.current ?? point;
      const computedIndex = getDropIndexFromTarget(event.currentTarget, fallbackPoint);
      const nextIndex =
        dropIndex ??
        pendingDropIndexRef.current ??
        computedIndex ??
        getClosestDropIndex(fallbackPoint.x, fallbackPoint.y);
      if (nextIndex === null) return;
      handleDropAt(nextIndex);
    },
    [dropIndex, getClosestDropIndex, getDropIndexFromTarget, handleDropAt, resolveClientPoint]
  );

  const handleDragEnd = useCallback(() => {
    dragStateRef.current = null;
    lastDragPointRef.current = null;
    setDropIndex(null);
  }, []);

  return {
    dropIndex,
    handleDragStart,
    handleDragOverToken,
    handleDragOverGap,
    handleDropAt,
    handleRowDragOver,
    handleRowDrop,
    handleDragEnd,
  };
};
