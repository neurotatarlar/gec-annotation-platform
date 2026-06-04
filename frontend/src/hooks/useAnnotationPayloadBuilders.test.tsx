import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAnnotationPayloadBuilders } from "./useAnnotationPayloadBuilders";

const builders = vi.hoisted(() => ({
  buildAnnotationsPayloadStandalone: vi.fn(async () => []),
  buildDraftCorrectionsStandalone: vi.fn(async () => []),
}));

vi.mock("../components/TokenEditorModel", () => ({
  buildAnnotationsPayloadStandalone: builders.buildAnnotationsPayloadStandalone,
  buildDraftCorrectionsStandalone: builders.buildDraftCorrectionsStandalone,
}));

describe("useAnnotationPayloadBuilders", () => {
  it("keeps save, render, and submit payload options explicit", async () => {
    const annotationIdMap = { current: new Map([["0-0", 12]]) };
    const annotationDeleteMap = { current: new Map([["1-1", [18]]]) };
    const tokens = [{ id: "t1", text: "hello", kind: "word", selected: false }];
    const originalTokens = [{ id: "o1", text: "helo", kind: "word", selected: false }];
    const correctionCards = [{ id: "0-0", rangeStart: 0, rangeEnd: 0 }];
    const correctionTypeMap = { "0-0": null };

    const { result } = renderHook(() =>
      useAnnotationPayloadBuilders({
        initialText: "helo",
        tokens: tokens as any,
        originalTokens: originalTokens as any,
        correctionCards,
        correctionTypeMap,
        moveMarkers: [],
        annotationIdMap,
        annotationDeleteMap,
      })
    );

    await result.current.buildAnnotationsPayload();
    await result.current.buildRenderPayload();
    await result.current.buildSubmitCorrections();

    expect(builders.buildAnnotationsPayloadStandalone).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        annotationIdMap: annotationIdMap.current,
        annotationDeleteMap: annotationDeleteMap.current,
        includeDeletedIds: true,
        allowUnassigned: true,
      })
    );
    expect(builders.buildAnnotationsPayloadStandalone).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        annotationIdMap: annotationIdMap.current,
        includeClientCorrectionId: true,
        allowUnassigned: true,
      })
    );
    expect(builders.buildDraftCorrectionsStandalone).toHaveBeenCalledWith(
      expect.objectContaining({
        annotationIdMap: annotationIdMap.current,
        allowUnassigned: true,
      })
    );
  });
});
