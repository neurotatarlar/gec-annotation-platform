import { useCallback } from "react";

import { Token } from "../components/TokenEditorModel";

type SelectionRange = { start: number | null; end: number | null };

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
