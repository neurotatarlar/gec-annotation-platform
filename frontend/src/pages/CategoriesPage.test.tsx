import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { CategoriesPage, parseUploadJson, mergeUploadEntries, type UploadEntry } from "./CategoriesPage";

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
vi.mock("../api/client", () => ({
  useAuthedApi: () => ({
    get: mockGet,
    post: mockPost,
    put: mockPut,
  }),
}));

const renderPage = (categories: any[]) => {
  mockGet.mockResolvedValueOnce({ data: categories });
  mockGet.mockResolvedValueOnce({ data: [] }); // skipped
  mockGet.mockResolvedValueOnce({ data: [] }); // trash
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <CategoriesPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
};

describe("parseUploadJson", () => {
  it("parses string or object items", () => {
    const input = JSON.stringify([
      "hello",
      { id: 123, text: "world" },
      { text: "skip me? " },
    ]);
    expect(parseUploadJson(input)).toEqual([
      { text: "hello" },
      { id: "123", text: "world" },
      { text: "skip me? " },
    ]);
  });

  it("throws on invalid json", () => {
    expect(() => parseUploadJson("not json")).toThrow();
  });

  it("throws on non-array json", () => {
    expect(() => parseUploadJson('{"text":"x"}')).toThrow();
  });

  it("throws on invalid item types", () => {
    const bad = JSON.stringify([123]);
    expect(() => parseUploadJson(bad)).toThrow();
  });
});

describe("mergeUploadEntries", () => {
  it("deduplicates by id when present, otherwise by text", () => {
    const merged = mergeUploadEntries([
      [
        { id: "a", text: "one" },
        { text: "two" },
      ],
      [
        { id: "a", text: "duplicate" },
        { text: "two" },
        { text: "three" },
      ],
    ] as UploadEntry[][]);
    expect(merged).toEqual([
      { id: "a", text: "one" },
      { text: "two" },
      { text: "three" },
    ]);
  });
});

describe("CategoriesPage visibility", () => {
  it("splits visible and hidden categories and toggles them", async () => {
    const categories = [
      { id: 1, name: "Visible", description: null, is_hidden: false, total_texts: 0, remaining_texts: 0, in_progress_texts: 0, awaiting_review_texts: 0 },
      { id: 2, name: "Hidden", description: null, is_hidden: true, total_texts: 0, remaining_texts: 0, in_progress_texts: 0, awaiting_review_texts: 0 },
    ];
    renderPage(categories);
    expect(await screen.findByText("Visible")).toBeInTheDocument();
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();

    const toggle = await screen.findByText("categories.hiddenGroup");
    fireEvent.click(toggle);
    expect(await screen.findByText("Hidden")).toBeInTheDocument();

    const hideBtn = screen.getByText("categories.hideCategory");
    fireEvent.click(hideBtn);
    await waitFor(() => expect(mockPut).toHaveBeenCalled());
  });
});
