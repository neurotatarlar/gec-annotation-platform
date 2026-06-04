import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";

import {
  DEFAULT_TOKEN_FONT_SIZE,
  DEFAULT_TOKEN_GAP,
  MIN_TOKEN_GAP,
  useTokenEditorPrefs,
} from "./useTokenEditorPrefs";

describe("useTokenEditorPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loads defaults when local preferences are absent", () => {
    const { result } = renderHook(() => useTokenEditorPrefs(1));

    expect(result.current.tokenGap).toBe(DEFAULT_TOKEN_GAP);
    expect(result.current.tokenFontSize).toBe(DEFAULT_TOKEN_FONT_SIZE);
    expect(result.current.spaceMarker).toBe("box");
    expect(result.current.viewTab).toBe("corrected");
    expect(result.current.isTextPanelOpen).toBe(true);
    expect(result.current.lastDecision).toBeNull();
  });

  it("loads stored UI preferences and clamps token gap minimum", () => {
    localStorage.setItem(
      "tokenEditorPrefs",
      JSON.stringify({
        tokenGap: -10,
        tokenFontSize: 30,
        spaceMarker: "dot",
        viewTab: "original",
        textPanelOpen: false,
        lastDecision: "skip",
        lastTextId: 7,
      })
    );

    const { result } = renderHook(() => useTokenEditorPrefs(7));

    expect(result.current.tokenGap).toBe(MIN_TOKEN_GAP);
    expect(result.current.tokenFontSize).toBe(30);
    expect(result.current.spaceMarker).toBe("dot");
    expect(result.current.viewTab).toBe("original");
    expect(result.current.isTextPanelOpen).toBe(false);
    expect(result.current.lastDecision).toBe("skip");
  });

  it("does not restore last decision for a different text", () => {
    localStorage.setItem(
      "tokenEditorPrefs",
      JSON.stringify({ lastDecision: "trash", lastTextId: 5 })
    );

    const { result } = renderHook(() => useTokenEditorPrefs(6));

    expect(result.current.lastDecision).toBeNull();
  });

  it("persists updated preferences with the current text id", () => {
    const { result } = renderHook(() => useTokenEditorPrefs(9));

    act(() => {
      result.current.setTokenGap(12);
      result.current.setTokenFontSize(28);
      result.current.setSpaceMarker("none");
      result.current.setViewTab("original");
      result.current.setIsTextPanelOpen(false);
      result.current.setLastDecision("submit");
    });

    const stored = JSON.parse(localStorage.getItem("tokenEditorPrefs") ?? "{}");
    expect(stored).toMatchObject({
      tokenGap: 12,
      tokenFontSize: 28,
      spaceMarker: "none",
      viewTab: "original",
      textPanelOpen: false,
      lastDecision: "submit",
      lastTextId: 9,
    });
  });
});
