import { useCallback, useEffect, useState } from "react";

import { CorrectionCardLite } from "../components/TokenEditorModel";

const typeKey = (textId: number) => `tokenEditorPrefs:types:${textId}`;

const loadCorrectionTypes = (
  textId: number
): { activeErrorTypeId: number | null; assignments: Record<string, number | null> } => {
  try {
    const raw = localStorage.getItem(typeKey(textId));
    if (!raw) return { activeErrorTypeId: null, assignments: {} };
    const parsed = JSON.parse(raw);
    return {
      activeErrorTypeId: typeof parsed?.activeErrorTypeId === "number" ? parsed.activeErrorTypeId : null,
      assignments: typeof parsed?.assignments === "object" && parsed.assignments ? parsed.assignments : {},
    };
  } catch {
    return { activeErrorTypeId: null, assignments: {} };
  }
};

const persistCorrectionTypes = (
  textId: number,
  payload: { activeErrorTypeId: number | null; assignments: Record<string, number | null> }
) => {
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
  const [activeErrorTypeId, setActiveErrorTypeId] = useState<number | null>(null);
  const [correctionTypeMap, setCorrectionTypeMap] = useState<Record<string, number | null>>({});
  const [hasLoadedTypeState, setHasLoadedTypeState] = useState(false);

  useEffect(() => {
    setHasLoadedTypeState(false);
    const typeState = loadCorrectionTypes(textId);
    setActiveErrorTypeId(typeState.activeErrorTypeId);
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
          next[card.id] = defaultType ?? activeErrorTypeId ?? null;
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
  }, [correctionCards, activeErrorTypeId, hasLoadedTypeState, defaultTypeForCard]);

  useEffect(() => {
    if (!hasLoadedTypeState) return;
    persistCorrectionTypes(textId, { activeErrorTypeId, assignments: correctionTypeMap });
  }, [textId, activeErrorTypeId, correctionTypeMap, hasLoadedTypeState]);

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
    activeErrorTypeId,
    setActiveErrorTypeId,
    correctionTypeMap,
    updateCorrectionType,
    applyTypeToCorrections,
    seedCorrectionTypes,
  };
};
