import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useErrorTypes } from "./useErrorTypes";

const createWrapper = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

describe("useErrorTypes", () => {
  it("loads error types and filters out noop", async () => {
    const loadErrorTypes = vi.fn().mockResolvedValue([
      { id: 1, en_name: "noop", is_active: true, default_color: "#999" },
      { id: 2, en_name: "Spelling", is_active: true, default_color: "#38bdf8" },
    ]);

    const { result } = renderHook(
      () =>
        useErrorTypes({
          enabled: true,
          loadErrorTypes,
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isLoadingErrorTypes).toBe(false));
    expect(loadErrorTypes).toHaveBeenCalledTimes(1);
    expect(result.current.errorTypes.map((item) => item.en_name)).toEqual(["Spelling"]);

    await act(async () => {
      await result.current.reload();
    });
    expect(loadErrorTypes).toHaveBeenCalledTimes(2);
  });

  it("does not load when disabled", async () => {
    const loadErrorTypes = vi.fn();

    const { result } = renderHook(
      () =>
        useErrorTypes({
          enabled: false,
          loadErrorTypes,
        }),
      { wrapper: createWrapper() }
    );

    expect(loadErrorTypes).not.toHaveBeenCalled();
    expect(result.current.errorTypes).toEqual([]);
    expect(result.current.errorTypesError).toBeNull();
  });

  it("surfaces API detail errors", async () => {
    const loadErrorTypes = vi.fn().mockRejectedValue({
      response: { data: { detail: "failed to load error types" } },
    });

    const { result } = renderHook(
      () =>
        useErrorTypes({
          enabled: true,
          loadErrorTypes,
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.errorTypesError).toBe("failed to load error types"));
  });
});
