import { useCallback, useEffect, useState } from "react";

import { CorrectionCardLite } from "../components/TokenEditorModel";

const typeKey = (textId: number) => `tokenEditorPrefs:types:${textId}`;

const loadCorrectionTypes = (textId: number): { assignments: Record<string, number | null> } => {
  try {
    const raw = localStorage.getItem(typeKey(textId));
    if (!raw) return { assignments: {} };
    const parsed = JSON.parse(raw);
    return {
      assignments: typeof parsed?.assignments === "object" && parsed.assignments ? parsed.assignments : {},
    };
  } catch {
    return { assignments: {} };
  }
};

const persistCorrectionTypes = (textId: number, payload: { assignments: Record<string, number | null> }) => {
  try {
    localStorage.setItem(typeKey(textId), JSON.stringify(payload));
  } catch {
    // ignore
  }
};

type UseCorrectionTypesArgs = {
  textId: number;
  correctionCards: CorrectionCardLite[];
  defaultTypeForCard?: (cardId: string) => number | null;
};

export const useCorrectionTypes = ({ textId, correctionCards, defaultTypeForCard }: UseCorrectionTypesArgs) => {
  const [correctionTypeMap, setCorrectionTypeMap] = useState<Record<string, number | null>>({});
  const [hasLoadedTypeState, setHasLoadedTypeState] = useState(false);

  useEffect(() => {
    setHasLoadedTypeState(false);
    const typeState = loadCorrectionTypes(textId);
    setCorrectionTypeMap(typeState.assignments);
    setHasLoadedTypeState(true);
  }, [textId]);

  useEffect(() => {
    if (!hasLoadedTypeState) return;
    setCorrectionTypeMap((prev) => {
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
  }, [correctionCards, hasLoadedTypeState, defaultTypeForCard]);

  useEffect(() => {
    if (!hasLoadedTypeState) return;
    persistCorrectionTypes(textId, { assignments: correctionTypeMap });
  }, [textId, correctionTypeMap, hasLoadedTypeState]);

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
    setCorrectionTypeMap((prev) => (Object.keys(prev).length === 0 ? seedMap : prev));
  }, []);

  return {
    correctionTypeMap,
    updateCorrectionType,
    applyTypeToCorrections,
    seedCorrectionTypes,
  };
};
