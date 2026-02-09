/**
 * Helper hook to delete token ranges and manage selection aftermath.
 */
import { useCallback } from "react";

import { Token } from "../components/TokenEditorModel";

type SelectionRange = { start: number | null; end: number | null };

type UseTokenDeleteRangeArgs = {
  tokens: Token[];
  selectionRef: React.MutableRefObject<SelectionRange>;
  lastClickedIndexRef: React.MutableRefObject<number | null>;
};

export const useTokenDeleteRange = ({
  tokens,
  selectionRef,
  lastClickedIndexRef,
}: UseTokenDeleteRangeArgs) => {
  const getDeleteRange = useCallback((): { range: [number, number]; anchorIndex?: number } | null => {
    const currentSelection = selectionRef.current;
    if (currentSelection.start === null || currentSelection.end === null) return null;
    const [start, end] = [
      Math.min(currentSelection.start, currentSelection.end),
      Math.max(currentSelection.start, currentSelection.end),
    ];
    if (start === end) return { range: [start, end], anchorIndex: start };
    const clickedIndex = lastClickedIndexRef.current;
    if (clickedIndex !== null && clickedIndex >= start && clickedIndex <= end) {
      const token = tokens[clickedIndex];
      if (token?.kind === "empty" && token.previousTokens?.length) {
        return { range: [clickedIndex, clickedIndex], anchorIndex: clickedIndex };
      }
    }
    const activeEl = document.activeElement as HTMLElement | null;
    const activeIndexAttr = activeEl?.getAttribute?.("data-token-index");
    const activeIndex = activeIndexAttr ? Number(activeIndexAttr) : null;
    if (activeIndex !== null && !Number.isNaN(activeIndex)) {
      const token = tokens[activeIndex];
      if (activeIndex >= start && activeIndex <= end && token?.kind === "empty" && token.previousTokens?.length) {
        return { range: [activeIndex, activeIndex], anchorIndex: activeIndex };
      }
    }
    const anchorIndex =
      clickedIndex !== null && clickedIndex >= start && clickedIndex <= end ? clickedIndex : undefined;
    return { range: [start, end], anchorIndex };
  }, [lastClickedIndexRef, selectionRef, tokens]);

  return { getDeleteRange };
};
