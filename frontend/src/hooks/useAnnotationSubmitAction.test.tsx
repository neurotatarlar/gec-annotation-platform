import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAnnotationSubmitAction } from "./useAnnotationSubmitAction";

const baseArgs = (overrides: Partial<Parameters<typeof useAnnotationSubmitAction>[0]> = {}) => ({
  textId: 1,
  buildSubmitCorrections: vi.fn(async () => [
    { clientId: "c1", operation: "replace" as const, errorTypeId: 1 },
  ]),
  saveAnnotations: vi.fn(async () => {}),
  post: vi.fn(async () => ({ data: {} })),
  requestNextText: vi.fn(async () => true),
  setLastDecision: vi.fn(),
  setActionError: vi.fn(),
  setActionMessage: vi.fn(),
  formatError: (error: any) => error?.message ?? String(error),
  ...overrides,
});

describe("useAnnotationSubmitAction", () => {
  it("blocks submit when a real correction is unlabeled", async () => {
    const saveAnnotations = vi.fn(async () => {});
    const post = vi.fn(async () => ({ data: {} }));
    const setActionError = vi.fn();
    const { result } = renderHook(() =>
      useAnnotationSubmitAction(
        baseArgs({
          buildSubmitCorrections: vi.fn(async () => [
            { clientId: "missing", operation: "replace", errorTypeId: null },
          ]),
          saveAnnotations,
          post,
          setActionError,
        })
      )
    );

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(setActionError).toHaveBeenCalledWith("Please assign an error type to all corrections.");
    expect(saveAnnotations).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("saves, submits, marks decision, and requests the next text", async () => {
    const saveAnnotations = vi.fn(async () => {});
    const post = vi.fn(async () => ({ data: {} }));
    const requestNextText = vi.fn(async () => true);
    const setLastDecision = vi.fn();
    const setActionError = vi.fn();
    const setActionMessage = vi.fn();
    const { result } = renderHook(() =>
      useAnnotationSubmitAction(
        baseArgs({
          saveAnnotations,
          post,
          requestNextText,
          setLastDecision,
          setActionError,
          setActionMessage,
        })
      )
    );

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(setActionError).toHaveBeenCalledWith(null);
    expect(setActionMessage).toHaveBeenCalledWith(null);
    expect(saveAnnotations).toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/api/texts/1/submit");
    expect(setLastDecision).toHaveBeenCalledWith("submit");
    expect(requestNextText).toHaveBeenCalled();
    expect(result.current.isSubmitting).toBe(false);
  });

  it("reports submit errors and clears loading state", async () => {
    const setActionError = vi.fn();
    const post = vi.fn(async () => {
      throw new Error("submit failed");
    });
    const { result } = renderHook(() =>
      useAnnotationSubmitAction(
        baseArgs({
          post,
          setActionError,
        })
      )
    );

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(setActionError).toHaveBeenLastCalledWith("submit failed");
    expect(result.current.isSubmitting).toBe(false);
  });
});
