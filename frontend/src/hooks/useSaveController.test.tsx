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
});
