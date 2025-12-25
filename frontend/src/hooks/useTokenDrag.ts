import { useCallback, useRef } from "react";
import type { Dispatch } from "react";

import { Token } from "../components/TokenEditorModel";
import { SelectionRange } from "./useEditorUIState";

type UseTokenDragArgs = {
  tokens: Token[];
  selectedSet: Set<number>;
  hasSelection: boolean;
  selection: SelectionRange;
  setSelection: (range: SelectionRange) => void;
  dispatch: Dispatch<any>;
  startDrag: () => void;
  endDrag: () => void;
  endEdit: () => void;
  setDropTarget: (index: number | null) => void;
  getDropIndexFromPoint: (clientX: number, clientY: number) => number | null;
};

export const useTokenDrag = ({
  tokens,
  selectedSet,
  hasSelection,
  selection,
  setSelection,
  dispatch,
  startDrag,
  endDrag,
  endEdit,
  setDropTarget,
  getDropIndexFromPoint,
}: UseTokenDragArgs) => {
  const dragInfoRef = useRef<{
    fromIndex: number;
    count: number;
    startX: number;
    startY: number;
    active: boolean;
    lastIndex: number | null;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const consumeClickSuppression = useCallback(() => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  }, []);

  const handleMouseDown = useCallback(
    (index: number, evt: React.MouseEvent, preserveSelection: boolean) => {
      if (evt.button !== 0) return;
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

      if (!preserveSelection && (!hasSelection || !selectedSet.has(index))) {
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
      dragInfoRef.current = {
        fromIndex: rangeStart,
        count,
        startX: evt.clientX,
        startY: evt.clientY,
        active: false,
        lastIndex: null,
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const info = dragInfoRef.current;
        if (!info) return;
        const dx = moveEvent.clientX - info.startX;
        const dy = moveEvent.clientY - info.startY;
        if (!info.active) {
          if (Math.hypot(dx, dy) < 4) return;
          info.active = true;
          suppressClickRef.current = true;
          startDrag();
        }
        const idx = getDropIndexFromPoint(moveEvent.clientX, moveEvent.clientY);
        if (idx !== null) {
          info.lastIndex = idx;
          setDropTarget(idx);
        }
      };

      const handleMouseUp = (upEvent: MouseEvent) => {
        const info = dragInfoRef.current;
        dragInfoRef.current = null;
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        setDropTarget(null);
        if (!info || !info.active) return;
        endDrag();
        const dropIndex =
          getDropIndexFromPoint(upEvent.clientX, upEvent.clientY) ?? info.lastIndex ?? tokens.length;
        const start = info.fromIndex;
        const end = info.fromIndex + info.count - 1;
        if (dropIndex >= start && dropIndex <= end + 1) return;
        const clampedTarget = Math.max(0, Math.min(tokens.length, dropIndex));
        dispatch({ type: "MOVE_SELECTED_BY_DRAG", fromIndex: info.fromIndex, toIndex: clampedTarget, count: info.count });
        setSelection({ start: null, end: null });
        endEdit();
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [
      dispatch,
      endDrag,
      endEdit,
      getDropIndexFromPoint,
      hasSelection,
      selectedSet,
      selection,
      setDropTarget,
      setSelection,
      startDrag,
      tokens.length,
    ]
  );

  return { handleMouseDown, consumeClickSuppression };
};
