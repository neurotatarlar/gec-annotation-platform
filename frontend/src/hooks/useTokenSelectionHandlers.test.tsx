import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Token } from "../components/TokenEditorModel";
import {
  estimateCaretIndexFromClick,
  expandEditRangeToTokenGroup,
  useTokenSelectionHandlers,
} from "./useTokenSelectionHandlers";

const token = (text: string, kind: Token["kind"] = "word"): Token => ({
  id: text,
  text,
  kind,
  selected: false,
});

describe("useTokenSelectionHandlers", () => {
  it("ignores clicks on special tokens", () => {
    const selectionRef = { current: { start: null, end: null } };
    const lastClickedIndexRef = { current: null as number | null };
    const setSelection = vi.fn();
    const tokens = [token("https://a.b", "special"), token("word")];

    const { result } = renderHook(() =>
      useTokenSelectionHandlers({
        tokens,
        selectionRef,
        lastClickedIndexRef,
        setSelection,
      })
    );

    result.current.handleTokenClick(0, false);
    expect(setSelection).not.toHaveBeenCalled();
    expect(lastClickedIndexRef.current).toBeNull();
  });

  it("selects a single token on plain click", () => {
    const selectionRef = { current: { start: null, end: null } };
    const lastClickedIndexRef = { current: null as number | null };
    const setSelection = vi.fn();
    const tokens = [token("a"), token("b"), token("c")];

    const { result } = renderHook(() =>
      useTokenSelectionHandlers({
        tokens,
        selectionRef,
        lastClickedIndexRef,
        setSelection,
      })
    );

    result.current.handleTokenClick(2, false);
    expect(lastClickedIndexRef.current).toBe(2);
    expect(selectionRef.current).toEqual({ start: 2, end: 2 });
    expect(setSelection).toHaveBeenCalledWith({ start: 2, end: 2 });
  });

  it("starts a selection on ctrl-click when there is no existing range", () => {
    const selectionRef = { current: { start: null, end: null } };
    const lastClickedIndexRef = { current: null as number | null };
    const setSelection = vi.fn();
    const tokens = [token("a"), token("b"), token("c")];

    const { result } = renderHook(() =>
      useTokenSelectionHandlers({
        tokens,
        selectionRef,
        lastClickedIndexRef,
        setSelection,
      })
    );

    result.current.handleTokenClick(1, true);
    expect(selectionRef.current).toEqual({ start: 1, end: 1 });
    expect(setSelection).toHaveBeenCalledWith({ start: 1, end: 1 });
  });

  it("expands selection range on ctrl-click with existing range", () => {
    const selectionRef = { current: { start: 1, end: 2 } };
    const lastClickedIndexRef = { current: 2 as number | null };
    const setSelection = vi.fn();
    const tokens = [token("a"), token("b"), token("c"), token("d")];

    const { result } = renderHook(() =>
      useTokenSelectionHandlers({
        tokens,
        selectionRef,
        lastClickedIndexRef,
        setSelection,
      })
    );

    result.current.handleTokenClick(0, true);
    expect(selectionRef.current).toEqual({ start: 0, end: 2 });
    expect(setSelection).toHaveBeenCalledWith({ start: 0, end: 2 });
  });
});

describe("expandEditRangeToTokenGroup", () => {
  it("expands to contiguous tokens sharing the same group id", () => {
    const tokens = [
      token("a"),
      { ...token("b"), groupId: "g1" },
      { ...token("c"), groupId: "g1" },
      { ...token("d"), groupId: "g1" },
      token("e"),
    ];

    expect(expandEditRangeToTokenGroup(tokens, 2)).toEqual({ start: 1, end: 3 });
  });

  it("keeps a single-token range when the token has no group id", () => {
    expect(expandEditRangeToTokenGroup([token("a"), token("b")], 1)).toEqual({ start: 1, end: 1 });
  });
});

describe("estimateCaretIndexFromClick", () => {
  it("maps click position to a clamped caret index", () => {
    expect(estimateCaretIndexFromClick(50, { left: 0, width: 100 }, "hello")).toBe(3);
    expect(estimateCaretIndexFromClick(-10, { left: 0, width: 100 }, "hello")).toBe(0);
    expect(estimateCaretIndexFromClick(120, { left: 0, width: 100 }, "hello")).toBe(5);
  });

  it("handles zero-width rectangles without dividing by zero", () => {
    expect(estimateCaretIndexFromClick(10, { left: 10, width: 0 }, "abc")).toBe(0);
  });
});
