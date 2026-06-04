/**
 * Hook for default error-type selection based on correction content.
 */
import { useCallback, useMemo } from "react";

import { ErrorType } from "../types";
import {
  CorrectionCardLite,
  MoveMarker,
  Token,
  buildEditableTextFromTokens,
} from "../components/TokenEditorModel";
import {
  detectCapitalizationEdit,
  detectSingleWhitespaceEdit,
  detectSpellingEdit,
  isPlainWordToken,
} from "../components/TokenEditorAutopick";

type UseCorrectionAutopickArgs = {
  errorTypes: ErrorType[];
  correctionCards: CorrectionCardLite[];
  moveMarkers: MoveMarker[];
  tokens: Token[];
  locale: string;
};

const findTypeId = (errorTypes: ErrorType[], name: string) => {
  const match = errorTypes.find(
    (type) => type.en_name?.trim().toLowerCase() === name
  );
  return match?.id ?? null;
};

export const useCorrectionAutopick = ({
  errorTypes,
  correctionCards,
  moveMarkers,
  tokens,
  locale,
}: UseCorrectionAutopickArgs) => {
  const moveCardIds = useMemo(
    () => new Set(moveMarkers.map((marker) => marker.id)),
    [moveMarkers]
  );
  const wordOrderTypeId = useMemo(() => findTypeId(errorTypes, "wordorder"), [errorTypes]);
  const hyphenTypeId = useMemo(() => findTypeId(errorTypes, "hyphen"), [errorTypes]);
  const punctuationTypeId = useMemo(() => findTypeId(errorTypes, "punctuation"), [errorTypes]);
  const splitTypeId = useMemo(() => findTypeId(errorTypes, "split"), [errorTypes]);
  const mergeTypeId = useMemo(() => findTypeId(errorTypes, "merge"), [errorTypes]);
  const capitalLowerTypeId = useMemo(() => findTypeId(errorTypes, "capitallowerletter"), [errorTypes]);
  const spellingTypeId = useMemo(() => findTypeId(errorTypes, "spelling"), [errorTypes]);
  const correctionCardById = useMemo(() => {
    const map = new Map<string, CorrectionCardLite>();
    correctionCards.forEach((card) => map.set(card.id, card));
    return map;
  }, [correctionCards]);

  const isSingleHyphenEdit = useCallback((beforeText: string, afterText: string) => {
    if (beforeText === afterText) return false;
    const countHyphen = (value: string) => (value.match(/-/g) ?? []).length;
    const hasSingleHyphen = (value: string) => countHyphen(value) === 1;
    const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
    const isHyphenBetweenWordChars = (value: string) => {
      const idx = value.indexOf("-");
      if (idx <= 0 || idx >= value.length - 1) return false;
      return isWordChar(value[idx - 1]) && isWordChar(value[idx + 1]);
    };
    const beforeHas = hasSingleHyphen(beforeText);
    const afterHas = hasSingleHyphen(afterText);
    if (beforeHas === afterHas) return false;
    if (beforeHas && !afterText.includes("-")) {
      if (beforeText.replace("-", "") !== afterText) return false;
      return isHyphenBetweenWordChars(beforeText);
    }
    if (afterHas && !beforeText.includes("-")) {
      if (afterText.replace("-", "") !== beforeText) return false;
      return isHyphenBetweenWordChars(afterText);
    }
    return false;
  }, []);

  const isSingleTokenDelta = useCallback(
    (beforeTokens: Token[], afterTokens: Token[], predicate: (tok: Token) => boolean) => {
      const matches = (left: Token, right: Token) =>
        left.text === right.text && left.kind === right.kind;
      if (afterTokens.length === beforeTokens.length + 1) {
        for (let i = 0; i < afterTokens.length; i += 1) {
          if (!predicate(afterTokens[i])) continue;
          const without = [...afterTokens.slice(0, i), ...afterTokens.slice(i + 1)];
          if (without.length !== beforeTokens.length) continue;
          if (without.every((tok, idx) => matches(tok, beforeTokens[idx]))) return true;
        }
      }
      if (beforeTokens.length === afterTokens.length + 1) {
        for (let i = 0; i < beforeTokens.length; i += 1) {
          if (!predicate(beforeTokens[i])) continue;
          const without = [...beforeTokens.slice(0, i), ...beforeTokens.slice(i + 1)];
          if (without.length !== afterTokens.length) continue;
          if (without.every((tok, idx) => matches(tok, afterTokens[idx]))) return true;
        }
      }
      return false;
    },
    []
  );

  const isHyphenCorrection = useCallback(
    (cardId: string) => {
      if (moveCardIds.has(cardId)) return false;
      const card = correctionCardById.get(cardId);
      if (!card) return false;
      const slice = tokens.slice(card.rangeStart, card.rangeEnd + 1);
      if (!slice.length) return false;
      const anchor = slice.find((tok) => tok.previousTokens?.length);
      const historyTokens = anchor?.previousTokens ?? [];
      const historyNonEmpty = historyTokens.filter((tok) => tok.kind !== "empty");
      const currentNonEmpty = slice.filter((tok) => tok.kind !== "empty");
      if (isSingleTokenDelta(historyNonEmpty, currentNonEmpty, (tok) => tok.text === "-")) {
        return true;
      }
      if (
        slice.length === 1 &&
        slice[0].kind === "empty" &&
        historyNonEmpty.length === 1 &&
        historyNonEmpty[0].text === "-"
      ) {
        return true;
      }
      if (
        currentNonEmpty.length === 1 &&
        currentNonEmpty[0].text === "-" &&
        historyTokens.length > 0 &&
        historyTokens.every((tok) => tok.kind === "empty")
      ) {
        return true;
      }
      if (!historyNonEmpty.length || !currentNonEmpty.length) return false;
      const beforeText = buildEditableTextFromTokens(historyNonEmpty);
      const afterText = buildEditableTextFromTokens(currentNonEmpty);
      return isSingleHyphenEdit(beforeText, afterText);
    },
    [correctionCardById, isSingleHyphenEdit, isSingleTokenDelta, moveCardIds, tokens]
  );

  const isPunctuationCorrection = useCallback(
    (cardId: string) => {
      if (moveCardIds.has(cardId)) return false;
      const card = correctionCardById.get(cardId);
      if (!card) return false;
      const slice = tokens.slice(card.rangeStart, card.rangeEnd + 1);
      if (!slice.length) return false;
      const anchor = slice.find((tok) => tok.previousTokens?.length);
      const historyTokens = anchor?.previousTokens ?? [];
      const historyNonEmpty = historyTokens.filter((tok) => tok.kind !== "empty");
      const currentNonEmpty = slice.filter((tok) => tok.kind !== "empty");
      if (
        isSingleTokenDelta(
          historyNonEmpty,
          currentNonEmpty,
          (tok) => tok.kind === "punct" && tok.text !== "-"
        )
      ) {
        return true;
      }
      if (
        slice.length === 1 &&
        slice[0].kind === "empty" &&
        historyNonEmpty.length === 1 &&
        historyNonEmpty[0].kind === "punct" &&
        historyNonEmpty[0].text !== "-"
      ) {
        return true;
      }
      if (
        currentNonEmpty.length === 1 &&
        currentNonEmpty[0].kind === "punct" &&
        currentNonEmpty[0].text !== "-" &&
        historyTokens.length > 0 &&
        historyTokens.every((tok) => tok.kind === "empty")
      ) {
        return true;
      }
      return false;
    },
    [correctionCardById, isSingleTokenDelta, moveCardIds, tokens]
  );

  const getWhitespaceCorrection = useCallback(
    (cardId: string) => {
      if (moveCardIds.has(cardId)) return null;
      const card = correctionCardById.get(cardId);
      if (!card) return null;
      const slice = tokens.slice(card.rangeStart, card.rangeEnd + 1);
      if (!slice.length) return null;
      const anchor = slice.find((tok) => tok.previousTokens?.length);
      const historyTokens = anchor?.previousTokens ?? [];
      const historyNonEmpty = historyTokens.filter((tok) => tok.kind !== "empty");
      const currentNonEmpty = slice.filter((tok) => tok.kind !== "empty");
      if (!historyNonEmpty.length || !currentNonEmpty.length) return null;
      const beforeText = buildEditableTextFromTokens(historyNonEmpty);
      const afterText = buildEditableTextFromTokens(currentNonEmpty);
      return detectSingleWhitespaceEdit(beforeText, afterText);
    },
    [correctionCardById, moveCardIds, tokens]
  );

  const getSingleWordEdit = useCallback(
    (cardId: string) => {
      if (moveCardIds.has(cardId)) return null;
      const card = correctionCardById.get(cardId);
      if (!card) return null;
      const slice = tokens.slice(card.rangeStart, card.rangeEnd + 1);
      if (!slice.length) return null;
      const anchor = slice.find((tok) => tok.previousTokens?.length);
      const historyTokens = anchor?.previousTokens ?? [];
      const historyNonEmpty = historyTokens.filter((tok) => tok.kind !== "empty");
      const currentNonEmpty = slice.filter((tok) => tok.kind !== "empty");
      if (historyNonEmpty.length !== 1 || currentNonEmpty.length !== 1) return null;
      const beforeText = historyNonEmpty[0].text;
      const afterText = currentNonEmpty[0].text;
      if (!isPlainWordToken(beforeText) || !isPlainWordToken(afterText)) return null;
      return { beforeText, afterText };
    },
    [correctionCardById, moveCardIds, tokens]
  );

  const defaultTypeForCard = useCallback(
    (cardId: string) => {
      if (wordOrderTypeId && moveCardIds.has(cardId)) return wordOrderTypeId;
      const whitespaceChange = getWhitespaceCorrection(cardId);
      if (whitespaceChange === "split" && mergeTypeId) return mergeTypeId;
      if (whitespaceChange === "merge" && splitTypeId) return splitTypeId;
      if (hyphenTypeId && isHyphenCorrection(cardId)) return hyphenTypeId;
      if (punctuationTypeId && isPunctuationCorrection(cardId)) return punctuationTypeId;
      const wordEdit = getSingleWordEdit(cardId);
      if (wordEdit && capitalLowerTypeId) {
        if (detectCapitalizationEdit(wordEdit.beforeText, wordEdit.afterText, locale)) {
          return capitalLowerTypeId;
        }
      }
      if (wordEdit && spellingTypeId) {
        if (detectSpellingEdit(wordEdit.beforeText, wordEdit.afterText)) {
          return spellingTypeId;
        }
      }
      return null;
    },
    [
      capitalLowerTypeId,
      getSingleWordEdit,
      getWhitespaceCorrection,
      hyphenTypeId,
      isHyphenCorrection,
      isPunctuationCorrection,
      mergeTypeId,
      moveCardIds,
      punctuationTypeId,
      spellingTypeId,
      splitTypeId,
      wordOrderTypeId,
      locale,
    ]
  );

  return { defaultTypeForCard };
};
