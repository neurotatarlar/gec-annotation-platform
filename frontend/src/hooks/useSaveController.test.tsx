import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useSaveController } from "./useSaveController";
import type { AnnotationDraft } from "../types";

describe("useSaveController", () => {
  it("dedupes concurrent saves for the same payload", async () => {
    const buildAnnotationsPayload = vi.fn(async (): Promise<AnnotationDraft[]> => [
      {
        start_token: 0,
        end_token: 0,
        replacement: "hi",
        error_type_id: 1,
        payload: { operation: "replace", before_tokens: ["hello"], after_tokens: [] },
      },
    ]);
    const post = vi.fn().mockResolvedValue({ data: [] });
    const annotationIdMap = { current: new Map() };
    const lastSavedSignatureRef = { current: null };
    const setServerAnnotationVersion = vi.fn();
    const result = renderHook(() =>
      useSaveController({
        tokens: ["hello"],
        buildAnnotationsPayload,
        post,
        textId: 1,
        serverAnnotationVersion: 0,
        setServerAnnotationVersion,
        annotationIdMap,
        lastSavedSignatureRef,
        formatError: (err) => String(err),
        setActionError: () => {},
      })
    );

    await act(async () => {
      const first = result.result.current.saveAnnotations();
      const second = result.result.current.saveAnnotations();
      await Promise.all([first, second]);
    });

    expect(post).toHaveBeenCalledTimes(1);
  });

  it("autosaves with the latest payload when metadata changes before the timer fires", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    vi.useFakeTimers();

    const annotationIdMap = { current: new Map() };
    const lastSavedSignatureRef = { current: null };
    const setServerAnnotationVersion = vi.fn();
    const post = vi.fn().mockResolvedValue({ data: [] });

    const baseAnnotation = {
      start_token: 0,
      end_token: 0,
      replacement: "hi",
      error_type_id: 1,
      payload: { operation: "replace", before_tokens: ["hello"], after_tokens: [] },
    };
    const buildPayloadA = vi.fn(async (): Promise<AnnotationDraft[]> => [baseAnnotation]);
    const buildPayloadB = vi.fn(async (): Promise<AnnotationDraft[]> => [
      { ...baseAnnotation, error_type_id: 2 },
    ]);

    const { rerender } = renderHook(
      ({ tokens, buildAnnotationsPayload }) =>
        useSaveController({
          tokens,
          buildAnnotationsPayload,
          post,
          textId: 1,
          serverAnnotationVersion: 0,
          setServerAnnotationVersion,
          annotationIdMap,
          lastSavedSignatureRef,
          formatError: (err) => String(err),
          setActionError: () => {},
        }),
      { initialProps: { tokens: ["hello"], buildAnnotationsPayload: buildPayloadA } }
    );

    rerender({ tokens: ["hello", "world"], buildAnnotationsPayload: buildPayloadA });
    rerender({ tokens: ["hello", "world"], buildAnnotationsPayload: buildPayloadB });

    await act(async () => {
      vi.advanceTimersByTime(801);
    });

    expect(post).toHaveBeenCalledTimes(1);
    const payload = post.mock.calls[0][1];
    expect(payload.annotations[0].error_type_id).toBe(2);

    vi.useRealTimers();
    process.env.NODE_ENV = originalEnv;
  });
});
