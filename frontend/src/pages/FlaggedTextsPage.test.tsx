import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { FlaggedTextsPage } from "./FlaggedTextsPage";

const mockNavigate = vi.fn();
const mockGet = vi.fn();
const mockDelete = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

vi.mock("../api/client", () => ({
  useAuthedApi: () => ({
    get: mockGet,
    delete: mockDelete,
  }),
}));

const renderPage = (path: string) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/categories/:categoryId/flags/:flagType" element={<FlaggedTextsPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
};

describe("FlaggedTextsPage", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockGet.mockReset();
    mockDelete.mockReset();
  });

  it("shows invalid category message for non-numeric route param", async () => {
    mockGet.mockResolvedValue({ data: [] });
    renderPage("/categories/not-a-number/flags/skip");

    expect(await screen.findByText("flags.invalidCategory")).toBeInTheDocument();
  });

  it("renders flagged entries and restores skip flag", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/categories/") {
        return Promise.resolve({ data: [{ id: 1, name: "Cat A" }] });
      }
      if (url === "/api/texts/flags") {
        return Promise.resolve({
          data: [
            {
              id: 9,
              reason: "bad quality",
              created_at: "2025-01-10T10:30:00.000Z",
              flag_type: "skip",
              text: { id: 101, content: "flagged text" },
            },
          ],
        });
      }
      throw new Error(`Unhandled url ${url}`);
    });
    mockDelete.mockResolvedValue({ data: {} });

    renderPage("/categories/1/flags/skip");

    expect(await screen.findByText("flagged text")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "flags.restore" }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("/api/texts/101/skip"));
  });

  it("navigates between skip and trash tabs", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/categories/") return Promise.resolve({ data: [{ id: 1, name: "Cat A" }] });
      if (url === "/api/texts/flags") return Promise.resolve({ data: [] });
      throw new Error(`Unhandled url ${url}`);
    });

    renderPage("/categories/1/flags/skip");

    expect(await screen.findByText("flags.empty")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "flags.tabTrash" }));
    expect(mockNavigate).toHaveBeenCalledWith("/categories/1/flags/trash");
  });
});
