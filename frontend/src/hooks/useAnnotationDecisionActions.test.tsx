import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAnnotationDecisionActions } from "./useAnnotationDecisionActions";

const baseArgs = (overrides: Partial<Parameters<typeof useAnnotationDecisionActions>[0]> = {}) => ({
  textId: 1,
  categoryId: 7,
  get: vi.fn(),
  post: vi.fn(),
  navigate: vi.fn(),
  queryClient: { setQueryData: vi.fn() },
  t: (key: string) => key,
  formatError: (error: any) => error?.message ?? String(error),
  pendingAction: null,
  flagReason: "",
  openFlagConfirm: vi.fn(),
  closeFlagConfirm: vi.fn(),
  updateFlagError: vi.fn(),
  setLastDecision: vi.fn(),
  ...overrides,
});

describe("useAnnotationDecisionActions", () => {
  it("requests next text, seeds query cache, and navigates", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { text: { id: 2, content: "next" } },
    });
    const queryClient = { setQueryData: vi.fn() };
    const navigate = vi.fn();
    const { result } = renderHook(() => useAnnotationDecisionActions(baseArgs({ post, queryClient, navigate })));

    let moved = false;
    await act(async () => {
      moved = await result.current.requestNextText();
    });

    expect(moved).toBe(true);
    expect(post).toHaveBeenCalledWith("/api/texts/assignments/next", null, {
      params: { category_id: 7 },
    });
    expect(queryClient.setQueryData).toHaveBeenCalledWith(["text", "2"], { id: 2, content: "next" });
    expect(navigate).toHaveBeenCalledWith("/annotate/2");
  });

  it("shows a no-texts message when assignment is temporarily unavailable", async () => {
    const post = vi.fn().mockRejectedValue({ response: { status: 404 } });
    const get = vi.fn().mockResolvedValue({ data: [{ id: 7, remaining_texts: 3 }] });
    const navigate = vi.fn();
    const { result } = renderHook(() => useAnnotationDecisionActions(baseArgs({ post, get, navigate })));

    let moved = true;
    await act(async () => {
      moved = await result.current.requestNextText();
    });

    expect(moved).toBe(false);
    expect(result.current.actionMessage).toBe("categories.noTextsAvailableNow");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens and confirms a flag action", async () => {
    const openFlagConfirm = vi.fn();
    const closeFlagConfirm = vi.fn();
    const updateFlagError = vi.fn();
    const setLastDecision = vi.fn();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { text: { id: 2 } } });
    const navigate = vi.fn();
    const { result } = renderHook(() =>
      useAnnotationDecisionActions(
        baseArgs({
          post,
          navigate,
          pendingAction: "skip",
          flagReason: "  later  ",
          openFlagConfirm,
          closeFlagConfirm,
          updateFlagError,
          setLastDecision,
        })
      )
    );

    act(() => {
      result.current.handleFlag("skip");
    });
    expect(openFlagConfirm).toHaveBeenCalledWith("skip");

    await act(async () => {
      await result.current.confirmFlag();
    });

    expect(post).toHaveBeenNthCalledWith(1, "/api/texts/1/skip", { reason: "later" });
    expect(setLastDecision).toHaveBeenCalledWith("skip");
    expect(navigate).toHaveBeenCalledWith("/annotate/2");
    expect(closeFlagConfirm).toHaveBeenCalled();
    expect(updateFlagError).toHaveBeenCalledWith(null);
  });

  it("keeps the flag modal open and reports validation errors", async () => {
    const closeFlagConfirm = vi.fn();
    const updateFlagError = vi.fn();
    const post = vi.fn().mockRejectedValue(new Error("bad reason"));
    const { result } = renderHook(() =>
      useAnnotationDecisionActions(
        baseArgs({
          post,
          pendingAction: "trash",
          flagReason: "bad",
          closeFlagConfirm,
          updateFlagError,
        })
      )
    );

    await act(async () => {
      await result.current.confirmFlag();
    });

    expect(updateFlagError).toHaveBeenCalledWith("bad reason");
    expect(closeFlagConfirm).not.toHaveBeenCalled();
    expect(result.current.isTrashing).toBe(false);
  });
});
