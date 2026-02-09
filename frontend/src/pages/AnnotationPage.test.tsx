import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AnnotationPage } from "./AnnotationPage";
import { SaveStatusProvider } from "../context/SaveStatusContext";

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

vi.mock("../api/client", () => ({
  useAuthedApi: () => ({
    get: mockGet,
    post: mockPost,
  }),
}));

const renderWithClient = (client: QueryClient, path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <SaveStatusProvider>
          <Routes>
            <Route path="/annotate/:textId" element={<AnnotationPage />} />
          </Routes>
        </SaveStatusProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );

describe("AnnotationPage", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ data: { id: "u1" } });
      if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
      if (url.includes("/api/texts/1/annotations")) return Promise.resolve({ data: [] });
      if (url === "/api/texts/1") {
        return Promise.resolve({ data: { id: 1, category_id: 1, content: "from-api" } });
      }
      return Promise.resolve({ data: {} });
    });
  });

  it("uses cached text data and skips fetching the text endpoint", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, cacheTime: 0 } },
    });
    client.setQueryData(["text", "1"], { id: 1, category_id: 1, content: "cached" });
    renderWithClient(client, "/annotate/1");

    await screen.findAllByRole("button", { name: "cached" });
    await waitFor(() => {
      const textCalls = mockGet.mock.calls.filter(([url]) => url === "/api/texts/1");
      expect(textCalls.length).toBe(0);
    });
  });

  it("fetches the text when cache is empty", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, cacheTime: 0 } },
    });
    renderWithClient(client, "/annotate/1");

    await screen.findByText("from-api");
    await waitFor(() => {
      const textCalls = mockGet.mock.calls.filter(([url]) => url === "/api/texts/1");
      expect(textCalls.length).toBe(1);
    });
  });
});
