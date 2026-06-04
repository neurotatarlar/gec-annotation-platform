import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { tokenEditorReducer, createInitialHistoryState } from "../components/TokenEditorModel";
import { useAnnotationInitialization } from "./useAnnotationInitialization";

describe("useAnnotationInitialization", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("initializes editor state from the text and resets hydration state", () => {
    const dispatch = vi.fn();
    const resetUI = vi.fn();
    const setServerAnnotationVersion = vi.fn();
    const setHasLoadedAnnotations = vi.fn();

    const { result } = renderHook(() =>
      useAnnotationInitialization({
        textId: 1,
        initialText: "alpha beta",
        currentUserId: "user-1",
        dispatch,
        resetUI,
        setServerAnnotationVersion,
        setHasLoadedAnnotations,
      })
    );

    expect(setServerAnnotationVersion).toHaveBeenCalledWith(0);
    expect(resetUI).toHaveBeenCalled();
    expect(setHasLoadedAnnotations).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "INIT_FROM_TEXT", text: "alpha beta" });
    expect(result.current.pendingLocalStateRef.current).toBeNull();
    expect(result.current.hydratedFromServerRef.current).toBe(false);
    expect(result.current.lastSavedSignatureRef.current).toBeNull();
  });

  it("initializes from saved editor state when test storage contains one", () => {
    const state = tokenEditorReducer(createInitialHistoryState(), {
      type: "INIT_FROM_TEXT",
      text: "alpha beta",
    }).present;
    localStorage.setItem("tokenEditorPrefs:state:5", JSON.stringify(state));
    const dispatch = vi.fn();

    const { result } = renderHook(() =>
      useAnnotationInitialization({
        textId: 5,
        initialText: "ignored",
        currentUserId: "user-1",
        dispatch,
        resetUI: vi.fn(),
        setServerAnnotationVersion: vi.fn(),
        setHasLoadedAnnotations: vi.fn(),
      })
    );

    expect(dispatch).toHaveBeenCalledWith({ type: "INIT_FROM_STATE", state });
    expect(result.current.pendingLocalStateRef.current).toEqual(state);
  });

  it("resets refs and initializes the next text when text id changes", () => {
    const dispatch = vi.fn();
    const resetUI = vi.fn();
    const setServerAnnotationVersion = vi.fn();
    const setHasLoadedAnnotations = vi.fn();

    const { result, rerender } = renderHook(
      ({ textId, initialText }) =>
        useAnnotationInitialization({
          textId,
          initialText,
          currentUserId: "user-1",
          dispatch,
          resetUI,
          setServerAnnotationVersion,
          setHasLoadedAnnotations,
        }),
      { initialProps: { textId: 1, initialText: "one" } }
    );

    result.current.hydratedFromServerRef.current = true;
    result.current.lastSavedSignatureRef.current = "saved";

    rerender({ textId: 2, initialText: "two" });

    expect(setServerAnnotationVersion).toHaveBeenLastCalledWith(0);
    expect(setHasLoadedAnnotations).toHaveBeenLastCalledWith(false);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "INIT_FROM_TEXT", text: "two" });
    expect(result.current.hydratedFromServerRef.current).toBe(false);
    expect(result.current.lastSavedSignatureRef.current).toBeNull();
  });

  it("builds hydration results with the current text and user", () => {
    const { result } = renderHook(() =>
      useAnnotationInitialization({
        textId: 1,
        initialText: "alpha beta",
        currentUserId: "user-1",
        dispatch: vi.fn(),
        resetUI: vi.fn(),
        setServerAnnotationVersion: vi.fn(),
        setHasLoadedAnnotations: vi.fn(),
      })
    );

    const hydrated = result.current.hydrateFromServerAnnotations([
      {
        id: 3,
        author_id: "user-1",
        start_token: 0,
        end_token: 0,
        replacement: "omega",
        error_type_id: 7,
        payload: {
          operation: "replace",
          text_tokens: ["alpha", "beta"],
          before_tokens: [{ id: "base-0", text: "alpha", origin: "base", space_before: false }],
          after_tokens: [{ id: "base-0", text: "omega", origin: "base", space_before: false }],
        },
      },
    ]);

    expect(hydrated?.typeMap).toEqual(expect.objectContaining({ "token-0": 7 }));
    expect(hydrated?.spanMap.get("0-0")).toBe(3);
  });
});
