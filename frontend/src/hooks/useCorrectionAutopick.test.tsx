import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ErrorType } from "../types";
import {
  createInitialHistoryState,
  deriveCorrectionCards,
  deriveMoveMarkers,
  tokenEditorReducer,
  type EditorHistoryState,
} from "../components/TokenEditorModel";
import { useCorrectionAutopick } from "./useCorrectionAutopick";

const errorTypes: ErrorType[] = [
  { id: 1, en_name: "WordOrder", tt_name: "WordOrder", is_active: true },
  { id: 2, en_name: "Hyphen", tt_name: "Hyphen", is_active: true },
  { id: 3, en_name: "Punctuation", tt_name: "Punctuation", is_active: true },
  { id: 4, en_name: "Split", tt_name: "Split", is_active: true },
  { id: 5, en_name: "Merge", tt_name: "Merge", is_active: true },
  { id: 6, en_name: "CapitalLowerLetter", tt_name: "CapitalLowerLetter", is_active: true },
  { id: 7, en_name: "Spelling", tt_name: "Spelling", is_active: true },
];

const init = (text: string) =>
  tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text });

const defaultTypeForFirstCard = (state: EditorHistoryState) => {
  const moveMarkers = deriveMoveMarkers(state.present.tokens);
  const correctionCards = deriveCorrectionCards(state.present.tokens, moveMarkers);
  const { result } = renderHook(() =>
    useCorrectionAutopick({
      errorTypes,
      correctionCards,
      moveMarkers,
      tokens: state.present.tokens,
      locale: "en",
    })
  );
  return result.current.defaultTypeForCard(correctionCards[0].id);
};

describe("useCorrectionAutopick", () => {
  it("defaults move corrections to WordOrder", () => {
    const state = tokenEditorReducer(init("alpha beta gamma"), {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 0,
      fromEnd: 0,
      toIndex: 2,
    });

    expect(defaultTypeForFirstCard(state)).toBe(1);
  });

  it("defaults punctuation-only corrections to Punctuation", () => {
    const state = tokenEditorReducer(init("alpha, beta"), {
      type: "DELETE_SELECTED_TOKENS",
      range: [1, 1],
    });

    expect(defaultTypeForFirstCard(state)).toBe(3);
  });

  it("defaults whitespace insertion to Merge according to existing labels", () => {
    const state = tokenEditorReducer(init("foobar"), {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo bar",
    });

    expect(defaultTypeForFirstCard(state)).toBe(5);
  });

  it("defaults capitalization-only edits to CapitalLowerLetter", () => {
    const state = tokenEditorReducer(init("alpha"), {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "Alpha",
    });

    expect(defaultTypeForFirstCard(state)).toBe(6);
  });

  it("defaults small word edits to Spelling", () => {
    const state = tokenEditorReducer(init("alpha"), {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "alpah",
    });

    expect(defaultTypeForFirstCard(state)).toBe(7);
  });
});
