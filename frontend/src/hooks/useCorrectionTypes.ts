/**
 * Hook mapping correction cards to error types with server-seeded defaults.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { CorrectionCardLite } from "../components/TokenEditorModel";

type UseCorrectionTypesArgs = {
  textId: number;
  correctionCards: CorrectionCardLite[];
  defaultTypeForCard?: (cardId: string) => number | null;
};

export const useCorrectionTypes = ({ textId, correctionCards, defaultTypeForCard }: UseCorrectionTypesArgs) => {
  const [correctionTypeMap, setCorrectionTypeMap] = useState<Record<string, number | null>>({});
  const hasSeenCorrectionsRef = useRef(false);
  const textIdRef = useRef(textId);

  useEffect(() => {
    if (textIdRef.current === textId) return;
    textIdRef.current = textId;
    setCorrectionTypeMap({});
    hasSeenCorrectionsRef.current = false;
  }, [textId]);

  useEffect(() => {
    if (correctionCards.length > 0) {
      hasSeenCorrectionsRef.current = true;
    }
  }, [correctionCards.length]);

  useEffect(() => {
    setCorrectionTypeMap((prev) => {
      if (correctionCards.length === 0 && !hasSeenCorrectionsRef.current) {
        return prev;
      }
      const next: Record<string, number | null> = {};
      correctionCards.forEach((card) => {
        const defaultType = defaultTypeForCard ? defaultTypeForCard(card.id) : null;
        const hasPrev = Object.prototype.hasOwnProperty.call(prev, card.id);
        const prevValue = hasPrev ? prev[card.id] : undefined;
        if (!hasPrev) {
          next[card.id] = defaultType ?? null;
          return;
        }
        if (prevValue === null && defaultType !== null && defaultType !== undefined) {
          next[card.id] = defaultType;
          return;
        }
        next[card.id] = prevValue ?? null;
      });
      const unchanged =
        correctionCards.length === Object.keys(prev).length &&
        correctionCards.every((c) => prev[c.id] === next[c.id]);
      return unchanged ? prev : next;
    });
  }, [correctionCards, defaultTypeForCard]);

  const updateCorrectionType = useCallback((cardId: string, typeId: number | null) => {
    setCorrectionTypeMap((prev) => ({ ...prev, [cardId]: typeId }));
  }, []);

  const applyTypeToCorrections = useCallback((ids: Iterable<string>, typeId: number) => {
    setCorrectionTypeMap((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        next[id] = typeId;
      }
      return next;
    });
  }, []);

  const seedCorrectionTypes = useCallback((seedMap: Record<string, number | null>) => {
    setCorrectionTypeMap(() => ({ ...seedMap }));
  }, []);

  return {
    correctionTypeMap,
    updateCorrectionType,
    applyTypeToCorrections,
    seedCorrectionTypes,
  };
};
