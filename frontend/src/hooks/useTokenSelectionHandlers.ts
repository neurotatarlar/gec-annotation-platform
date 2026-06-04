/**
 * Hook for mouse/keyboard selection logic in the token editor.
 */
import { useCallback } from "react";

import { Token } from "../components/TokenEditorModel";

type SelectionRange = { start: number | null; end: number | null };

type RectLike = {
  left: number;
  width: number;
};

export const expandEditRangeToTokenGroup = (tokens: Token[], index: number): SelectionRange => {
  const token = tokens[index];
  const groupId = token?.groupId;
  let start = index;
  let end = index;
  if (groupId) {
    while (start - 1 >= 0 && tokens[start - 1]?.groupId === groupId) start -= 1;
    while (end + 1 < tokens.length && tokens[end + 1]?.groupId === groupId) end += 1;
  }
  return { start, end };
};

export const estimateCaretIndexFromClick = (
  clientX: number,
  rect: RectLike,
  tokenText: string
) => {
  const relative = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
  return Math.round(relative * tokenText.length);
};

type UseTokenSelectionHandlersArgs = {
  tokens: Token[];
  selectionRef: React.MutableRefObject<SelectionRange>;
  lastClickedIndexRef: React.MutableRefObject<number | null>;
  setSelection: (range: SelectionRange) => void;
};

export const useTokenSelectionHandlers = ({
  tokens,
  selectionRef,
  lastClickedIndexRef,
  setSelection,
}: UseTokenSelectionHandlersArgs) => {
  const handleTokenClick = useCallback(
    (index: number, ctrlKey: boolean) => {
      if (tokens[index]?.kind === "special") return;
      lastClickedIndexRef.current = index;
      const currentSelection = selectionRef.current;
      if (!ctrlKey) {
        const range = { start: index, end: index };
        selectionRef.current = range;
        setSelection(range);
        return;
      }
      if (currentSelection.start === null || currentSelection.end === null) {
        const range = { start: index, end: index };
        selectionRef.current = range;
        setSelection(range);
        return;
      }
      const [s, e] = [currentSelection.start, currentSelection.end];
      const start = Math.min(s, e, index);
      const end = Math.max(s, e, index);
      const range = { start, end };
      selectionRef.current = range;
      setSelection(range);
    },
    [lastClickedIndexRef, selectionRef, setSelection, tokens]
  );

  return { handleTokenClick };
};
