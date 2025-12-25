import { useCallback, useEffect, useRef } from "react";

import { CorrectionCardLite, Token, findGroupRangeForTokens } from "../components/TokenEditorModel";
import { SelectionRange } from "./useEditorUIState";

type UseCorrectionSelectionArgs = {
  correctionCards: CorrectionCardLite[];
  tokens: Token[];
  setSelection: (range: SelectionRange, markerId?: string | null) => void;
};

export const useCorrectionSelection = ({
  correctionCards,
  tokens,
  setSelection,
}: UseCorrectionSelectionArgs) => {
  const pendingSelectIndexRef = useRef<number | null>(null);
  const skipAutoSelectRef = useRef(false);
  const prevCorrectionCountRef = useRef(0);
  const correctionSignatureRef = useRef<string | null>(null);
  const prevCorrectionIdsRef = useRef<Set<string>>(new Set());

  const markSkipAutoSelect = useCallback(() => {
    skipAutoSelectRef.current = true;
  }, []);

  const setPendingSelectIndex = useCallback((index: number | null) => {
    pendingSelectIndexRef.current = index;
  }, []);

  useEffect(() => {
    const signature = correctionCards.map((c) => `${c.id}:${c.rangeStart}-${c.rangeEnd}`).join("|");
    const prevIds = prevCorrectionIdsRef.current;
    const currentIds = correctionCards.map((c) => c.id);
    const addedIds = currentIds.filter((id) => !prevIds.has(id));
    const prevCount = prevCorrectionCountRef.current;
    const shouldSkipAuto = skipAutoSelectRef.current && correctionCards.length <= prevCount;
    if (signature !== correctionSignatureRef.current && correctionCards.length) {
      if (shouldSkipAuto) {
        setSelection({ start: null, end: null });
        skipAutoSelectRef.current = false;
      } else {
        const desiredIdx = pendingSelectIndexRef.current;
        if (desiredIdx !== null && tokens.length) {
          const clamped = Math.max(0, Math.min(tokens.length - 1, desiredIdx));
          const [start, end] = findGroupRangeForTokens(tokens, clamped);
          setSelection({ start, end });
        } else {
          const addedTargetId = addedIds.length ? addedIds[addedIds.length - 1] : null;
          const addedTarget = addedTargetId ? correctionCards.find((c) => c.id === addedTargetId) : null;
          const target =
            addedTarget ||
            correctionCards[correctionCards.length - 1];
          if (target) {
            const [start, end] = findGroupRangeForTokens(tokens, target.rangeStart);
            setSelection({ start, end });
          }
        }
      }
    }
    correctionSignatureRef.current = signature;
    if (!shouldSkipAuto) {
      skipAutoSelectRef.current = false;
    }
    prevCorrectionIdsRef.current = new Set(currentIds);
    pendingSelectIndexRef.current = null;
  }, [correctionCards, setSelection, tokens]);

  useEffect(() => {
    if (correctionCards.length < prevCorrectionCountRef.current) {
      setSelection({ start: null, end: null });
    }
  }, [correctionCards.length, setSelection]);

  useEffect(() => {
    prevCorrectionCountRef.current = correctionCards.length;
  }, [correctionCards.length]);

  return { markSkipAutoSelect, setPendingSelectIndex };
};
