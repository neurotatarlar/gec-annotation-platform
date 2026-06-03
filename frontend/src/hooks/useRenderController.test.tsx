import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useRenderController } from "./useRenderController";

const withDevelopmentEnv = async (run: () => Promise<void>) => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    await run();
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
};

describe("useRenderController", () => {
  it("uses local corrected text without posting when there are no corrections", async () => {
    await withDevelopmentEnv(async () => {
      const post = vi.fn();
      const buildRenderPayload = vi.fn(async () => []);

      const result = renderHook(() =>
        useRenderController({
          textId: 1,
          resetKey: 1,
          tokensLength: 2,
          correctionCount: 0,
          hasLoadedAnnotations: true,
          localCorrectedText: "hello world",
          buildRenderPayload,
          post,
        })
      );

      await waitFor(() => expect(result.result.current.hasCanonicalRender).toBe(true));
      expect(result.result.current.correctedText).toBe("hello world");
      expect(result.result.current.isRenderPending).toBe(false);
      expect(post).not.toHaveBeenCalled();
      expect(buildRenderPayload).not.toHaveBeenCalled();
    });
  });

  it("debounces and uses backend rendered corrected text", async () => {
    await withDevelopmentEnv(async () => {
      vi.useFakeTimers();
      try {
        const post = vi.fn().mockResolvedValue({ data: { corrected_text: "server text" } });
        const buildRenderPayload = vi.fn(async () => [{ start_token: 0 }]);

        const result = renderHook(() =>
          useRenderController({
            textId: 2,
            resetKey: 2,
            tokensLength: 2,
            correctionCount: 1,
            hasLoadedAnnotations: true,
            localCorrectedText: "local text",
            buildRenderPayload,
            post,
            debounceMs: 25,
          })
        );

        expect(result.result.current.isRenderPending).toBe(true);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(26);
        });

        expect(result.result.current.correctedText).toBe("server text");
        expect(result.result.current.isRenderPending).toBe(false);
        expect(post).toHaveBeenCalledWith(
          "/api/texts/2/render",
          { annotations: [{ start_token: 0 }] },
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("falls back to local corrected text when backend render fails", async () => {
    await withDevelopmentEnv(async () => {
      vi.useFakeTimers();
      try {
        const post = vi.fn().mockRejectedValue(new Error("render failed"));
        const buildRenderPayload = vi.fn(async () => [{ start_token: 0 }]);

        const result = renderHook(() =>
          useRenderController({
            textId: 3,
            resetKey: 3,
            tokensLength: 2,
            correctionCount: 1,
            hasLoadedAnnotations: true,
            localCorrectedText: "local fallback",
            buildRenderPayload,
            post,
            debounceMs: 25,
          })
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(26);
        });

        expect(result.result.current.hasCanonicalRender).toBe(true);
        expect(result.result.current.correctedText).toBe("local fallback");
        expect(result.result.current.isRenderPending).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
