import { useCallback, useRef } from "react";
import type { Dispatch } from "react";

import { Token } from "../components/TokenEditorModel";
import { SelectionRange } from "./useEditorUIState";

type UseTokenDragArgs = {
  tokens: Token[];
  selectedIndices: number[];
  selectedSet: Set<number>;
  hasSelection: boolean;
  selection: SelectionRange;
  setSelection: (range: SelectionRange) => void;
  dispatch: Dispatch<any>;
  startDrag: () => void;
  endDrag: () => void;
  endEdit: () => void;
  setDropTarget: (index: number | null) => void;
};

export const useTokenDrag = ({
  tokens,
  selectedIndices,
  selectedSet,
  hasSelection,
  selection,
  setSelection,
  dispatch,
  startDrag,
  endDrag,
  endEdit,
  setDropTarget,
}: UseTokenDragArgs) => {
  const dragInfoRef = useRef<{ fromIndex: number; count: number } | null>(null);

  const handleDragStart = useCallback(
    (index: number, evt: React.DragEvent) => {
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
      startDrag();
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
    },
    [hasSelection, selectedIndices, selectedSet, selection, setSelection, startDrag, tokens]
  );

  const handleDrop = useCallback(
    (targetIndex: number) => {
      const info = dragInfoRef.current;
      dragInfoRef.current = null;
      setDropTarget(null);
      endDrag();
      if (!info) return;
      const { fromIndex, count } = info;
      const start = fromIndex;
      const end = fromIndex + count - 1;
      // Ignore drops inside the same block (no movement).
      if (targetIndex >= start && targetIndex <= end + 1) return;
      dispatch({ type: "MOVE_SELECTED_BY_DRAG", fromIndex, toIndex: targetIndex, count });
      // After moving, clear selection so the moved tokens don't show a background.
      setSelection({ start: null, end: null });
      endEdit();
    },
    [dispatch, endDrag, endEdit, setDropTarget, setSelection]
  );

  const handleDragEnd = useCallback(() => {
    dragInfoRef.current = null;
    setDropTarget(null);
    endDrag();
  }, [endDrag, setDropTarget]);

  return { handleDragStart, handleDrop, handleDragEnd };
};
