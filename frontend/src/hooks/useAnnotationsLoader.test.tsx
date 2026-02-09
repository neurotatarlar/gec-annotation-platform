import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EditorPresentState } from "../components/TokenEditorModel";
import { useAnnotationsLoader } from "./useAnnotationsLoader";

const emptyPresent = (): EditorPresentState => ({
  originalTokens: [],
  tokens: [],
  operations: [],
});

describe("useAnnotationsLoader", () => {
  it("hydrates from server annotations and seeds correction types", async () => {
    const hydrated = {
      present: emptyPresent(),
      typeMap: { "1-2": 7 },
      spanMap: new Map<string, number>([["1-2", 11]]),
    };
    const get = vi.fn().mockResolvedValue({
      data: [{ id: 11, start_token: 1, end_token: 2, version: 3, author_id: "user-1" }],
    });
    const hydrateFromServerAnnotations = vi.fn().mockReturnValue(hydrated);
    const dispatch = vi.fn();
    const seedCorrectionTypes = vi.fn();
    const setServerAnnotationVersion = vi.fn();
    const onLoaded = vi.fn();
    const pendingLocalStateRef = { current: null };
    const hydratedFromServerRef = { current: false };
    const annotationIdMap = { current: new Map<string, number>() };
    const annotationDeleteMap = { current: new Map<string, number[]>() };

    renderHook(() =>
      useAnnotationsLoader({
        textId: 99,
        currentUserId: "user-1",
        get,
        hydrateFromServerAnnotations,
        dispatch,
        seedCorrectionTypes,
        pendingLocalStateRef,
        hydratedFromServerRef,
        annotationIdMap,
        annotationDeleteMap,
        setServerAnnotationVersion,
        onLoaded,
      })
    );

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: "INIT_FROM_STATE", state: hydrated.present })
    );
    expect(seedCorrectionTypes).toHaveBeenCalledWith(hydrated.typeMap);
    expect(setServerAnnotationVersion).toHaveBeenCalledWith(3);
    expect(hydratedFromServerRef.current).toBe(true);
    expect(annotationIdMap.current).toBe(hydrated.spanMap);
    expect(annotationDeleteMap.current.get("1-2")).toEqual([11]);
    expect(onLoaded).toHaveBeenCalledWith(99);
  });

  it("falls back to pending local state when hydration returns null", async () => {
    const localState = emptyPresent();
    const get = vi.fn().mockResolvedValue({
      data: [{ id: 21, start_token: 0, end_token: 0, version: 1, author_id: "user-1" }],
    });
    const hydrateFromServerAnnotations = vi.fn().mockReturnValue(null);
    const dispatch = vi.fn();
    const seedCorrectionTypes = vi.fn();
    const setServerAnnotationVersion = vi.fn();
    const pendingLocalStateRef = { current: localState };
    const hydratedFromServerRef = { current: false };
    const annotationIdMap = { current: new Map<string, number>() };
    const annotationDeleteMap = { current: new Map<string, number[]>() };

    renderHook(() =>
      useAnnotationsLoader({
        textId: 7,
        currentUserId: "user-1",
        get,
        hydrateFromServerAnnotations,
        dispatch,
        seedCorrectionTypes,
        pendingLocalStateRef,
        hydratedFromServerRef,
        annotationIdMap,
        annotationDeleteMap,
        setServerAnnotationVersion,
      })
    );

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: "INIT_FROM_STATE", state: localState })
    );
    expect(seedCorrectionTypes).not.toHaveBeenCalled();
    expect(hydratedFromServerRef.current).toBe(true);
  });

  it("maps annotation ids for current user when already hydrated", async () => {
    const get = vi.fn().mockResolvedValue({
      data: [
        { id: 1, start_token: 0, end_token: 0, version: 2, author_id: "user-1" },
        { id: 2, start_token: 1, end_token: 1, version: 4, author_id: "user-2" },
      ],
    });
    const hydrateFromServerAnnotations = vi.fn().mockReturnValue({
      present: emptyPresent(),
      typeMap: {},
      spanMap: new Map<string, number>(),
    });
    const dispatch = vi.fn();
    const seedCorrectionTypes = vi.fn();
    const setServerAnnotationVersion = vi.fn();
    const pendingLocalStateRef = { current: null };
    const hydratedFromServerRef = { current: true };
    const annotationIdMap = { current: new Map<string, number>() };
    const annotationDeleteMap = { current: new Map<string, number[]>() };

    renderHook(() =>
      useAnnotationsLoader({
        textId: 8,
        currentUserId: "user-1",
        get,
        hydrateFromServerAnnotations,
        dispatch,
        seedCorrectionTypes,
        pendingLocalStateRef,
        hydratedFromServerRef,
        annotationIdMap,
        annotationDeleteMap,
        setServerAnnotationVersion,
      })
    );

    await waitFor(() => expect(setServerAnnotationVersion).toHaveBeenCalledWith(4));
    expect(dispatch).not.toHaveBeenCalled();
    expect(annotationIdMap.current.get("0-0")).toBe(1);
    expect(annotationIdMap.current.has("1-1")).toBe(false);
  });

  it("clears annotation maps when server returns no items", async () => {
    const get = vi.fn().mockResolvedValue({ data: [] });
    const hydrateFromServerAnnotations = vi.fn().mockReturnValue(null);
    const dispatch = vi.fn();
    const seedCorrectionTypes = vi.fn();
    const setServerAnnotationVersion = vi.fn();
    const pendingLocalStateRef = { current: null };
    const hydratedFromServerRef = { current: true };
    const annotationIdMap = { current: new Map<string, number>([["0-0", 1]]) };
    const annotationDeleteMap = { current: new Map<string, number[]>([["0-0", [1]]]) };

    renderHook(() =>
      useAnnotationsLoader({
        textId: 13,
        currentUserId: "user-1",
        get,
        hydrateFromServerAnnotations,
        dispatch,
        seedCorrectionTypes,
        pendingLocalStateRef,
        hydratedFromServerRef,
        annotationIdMap,
        annotationDeleteMap,
        setServerAnnotationVersion,
      })
    );

    await waitFor(() => expect(setServerAnnotationVersion).toHaveBeenCalledWith(0));
    expect(annotationIdMap.current.size).toBe(0);
    expect(annotationDeleteMap.current.size).toBe(0);
  });

  it("swallows load errors but still calls onLoaded", async () => {
    const get = vi.fn().mockRejectedValue(new Error("network fail"));
    const hydrateFromServerAnnotations = vi.fn();
    const dispatch = vi.fn();
    const seedCorrectionTypes = vi.fn();
    const setServerAnnotationVersion = vi.fn();
    const onLoaded = vi.fn();
    const pendingLocalStateRef = { current: null };
    const hydratedFromServerRef = { current: false };
    const annotationIdMap = { current: new Map<string, number>() };
    const annotationDeleteMap = { current: new Map<string, number[]>() };

    renderHook(() =>
      useAnnotationsLoader({
        textId: 77,
        currentUserId: "user-1",
        get,
        hydrateFromServerAnnotations,
        dispatch,
        seedCorrectionTypes,
        pendingLocalStateRef,
        hydratedFromServerRef,
        annotationIdMap,
        annotationDeleteMap,
        setServerAnnotationVersion,
        onLoaded,
      })
    );

    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith(77));
    expect(dispatch).not.toHaveBeenCalled();
    expect(seedCorrectionTypes).not.toHaveBeenCalled();
  });

  it("does not reload on rerender when textId is unchanged", async () => {
    const get = vi.fn().mockResolvedValue({ data: [] });
    const hydrateFromServerAnnotations = vi.fn().mockReturnValue(null);
    const dispatch = vi.fn();
    const seedCorrectionTypes = vi.fn();
    const setServerAnnotationVersion = vi.fn();
    const onLoaded = vi.fn();
    const pendingLocalStateRef = { current: null };
    const hydratedFromServerRef = { current: false };
    const annotationIdMap = { current: new Map<string, number>() };
    const annotationDeleteMap = { current: new Map<string, number[]>() };

    const { rerender } = renderHook(
      ({ textId }) =>
        useAnnotationsLoader({
          textId,
          currentUserId: "user-1",
          get,
          hydrateFromServerAnnotations,
          dispatch,
          seedCorrectionTypes,
          pendingLocalStateRef,
          hydratedFromServerRef,
          annotationIdMap,
          annotationDeleteMap,
          setServerAnnotationVersion,
          onLoaded,
        }),
      { initialProps: { textId: 55 } }
    );

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    rerender({ textId: 55 });

    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith(55));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
