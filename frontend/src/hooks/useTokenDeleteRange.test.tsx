import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Token } from "../components/TokenEditorModel";
import { useTokenDeleteRange } from "./useTokenDeleteRange";

const makeToken = (text: string): Token => ({
  id: text,
  text,
  kind: "word",
  selected: false,
});

describe("useTokenDeleteRange", () => {
  it("returns null when selection is empty", () => {
    const selectionRef = { current: { start: null, end: null } };
    const lastClickedIndexRef = { current: null };
    const { result } = renderHook(() =>
      useTokenDeleteRange({
        tokens: [makeToken("a")],
        selectionRef,
        lastClickedIndexRef,
      })
    );

    expect(result.current.getDeleteRange()).toBeNull();
  });

  it("returns exact single-token range with anchor", () => {
    const selectionRef = { current: { start: 1, end: 1 } };
    const lastClickedIndexRef = { current: 1 };
    const { result } = renderHook(() =>
      useTokenDeleteRange({
        tokens: [makeToken("a"), makeToken("b"), makeToken("c")],
        selectionRef,
        lastClickedIndexRef,
      })
    );

    expect(result.current.getDeleteRange()).toEqual({ range: [1, 1], anchorIndex: 1 });
  });

  it("narrows multi-selection to clicked history placeholder", () => {
    const placeholder: Token = {
      id: "ph",
      text: "⬚",
      kind: "empty",
      selected: false,
      previousTokens: [makeToken("x")],
    };
    const tokens = [makeToken("a"), placeholder, makeToken("b")];
    const selectionRef = { current: { start: 0, end: 2 } };
    const lastClickedIndexRef = { current: 1 };
    const { result } = renderHook(() =>
      useTokenDeleteRange({
        tokens,
        selectionRef,
        lastClickedIndexRef,
      })
    );

    expect(result.current.getDeleteRange()).toEqual({ range: [1, 1], anchorIndex: 1 });
  });

  it("uses focused history placeholder when clicked index is outside range", () => {
    const placeholder: Token = {
      id: "ph",
      text: "⬚",
      kind: "empty",
      selected: false,
      previousTokens: [makeToken("x")],
    };
    const tokens = [makeToken("a"), placeholder, makeToken("b")];
    const selectionRef = { current: { start: 0, end: 2 } };
    const lastClickedIndexRef = { current: 99 };

    const el = document.createElement("button");
    el.setAttribute("data-token-index", "1");
    document.body.appendChild(el);
    el.focus();

    const { result } = renderHook(() =>
      useTokenDeleteRange({
        tokens,
        selectionRef,
        lastClickedIndexRef,
      })
    );

    expect(result.current.getDeleteRange()).toEqual({ range: [1, 1], anchorIndex: 1 });

    el.remove();
  });
});
