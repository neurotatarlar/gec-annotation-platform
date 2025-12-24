import { useCallback, useEffect, useRef } from "react";

import {
  CorrectionCardLite,
  MoveMarker,
  Token,
  findGroupRangeForTokens,
} from "../components/TokenEditorModel";
import { SelectionRange } from "./useEditorUIState";

type UseCorrectionSelectionArgs = {
  correctionCards: CorrectionCardLite[];
  tokens: Token[];
  moveMarkers: MoveMarker[];
  moveMarkerById: Map<string, MoveMarker>;
  setSelection: (range: SelectionRange, markerId?: string | null) => void;
};

export const useCorrectionSelection = ({
  correctionCards,
  tokens,
  moveMarkers,
  moveMarkerById,
  setSelection,
}: UseCorrectionSelectionArgs) => {
  const pendingSelectIndexRef = useRef<number | null>(null);
  const skipAutoSelectRef = useRef(false);
  const prevCorrectionCountRef = useRef(0);
  const correctionSignatureRef = useRef<string | null>(null);
  const moveSignatureRef = useRef<string | null>(null);
  const prevCorrectionIdsRef = useRef<Set<string>>(new Set());

  const markSkipAutoSelect = useCallback(() => {
    skipAutoSelectRef.current = true;
  }, []);

  const setPendingSelectIndex = useCallback((index: number | null) => {
    pendingSelectIndexRef.current = index;
  }, []);

  useEffect(() => {
    const signature = correctionCards.map((c) => `${c.id}:${c.rangeStart}-${c.rangeEnd}`).join("|");
    const moveSignature = moveMarkers.map((m) => `${m.id}:${m.fromStart}-${m.fromEnd}:${m.toStart}-${m.toEnd}`).join("|");
    const moveChanged = moveSignature !== moveSignatureRef.current;
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
          const latestMove = moveChanged ? moveMarkers[moveMarkers.length - 1] : null;
          const target =
            addedTarget ||
            (latestMove && correctionCards.find((c) => c.markerId === latestMove.id)) ||
            [...correctionCards].reverse().find((c) => !c.markerId) ||
            correctionCards[correctionCards.length - 1];
          if (target) {
            if (target.markerId) {
              const marker = moveMarkerById.get(target.markerId);
              if (marker) {
                const start = Math.min(marker.fromStart, marker.toStart);
                const end = Math.max(marker.fromEnd, marker.toEnd);
                setSelection({ start, end }, target.markerId);
              }
            } else {
              const [start, end] = findGroupRangeForTokens(tokens, target.rangeStart);
              setSelection({ start, end });
            }
          }
        }
      }
    }
    correctionSignatureRef.current = signature;
    moveSignatureRef.current = moveSignature;
    if (!shouldSkipAuto) {
      skipAutoSelectRef.current = false;
    }
    prevCorrectionIdsRef.current = new Set(currentIds);
    pendingSelectIndexRef.current = null;
  }, [correctionCards, moveMarkers, moveMarkerById, setSelection, tokens]);

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
