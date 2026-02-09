import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { HistoryPage } from "./HistoryPage";

const mockNavigate = vi.fn();
const mockGet = vi.fn();

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
  }),
}));

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <HistoryPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
};

describe("HistoryPage", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockGet.mockReset();
  });

  it("renders history items and navigates to annotate page", async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        {
          text_id: 42,
          status: "submitted",
          updated_at: "2025-01-10T10:30:00.000Z",
          preview: "demo preview",
        },
      ],
    });

    renderPage();

    expect(await screen.findByText("history.title")).toBeInTheDocument();
    expect(await screen.findByText(/#42/)).toBeInTheDocument();
    expect(await screen.findByText("demo preview")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "history.open" }));
    expect(mockNavigate).toHaveBeenCalledWith("/annotate/42");
  });

  it("refresh button triggers refetch", async () => {
    mockGet.mockResolvedValue({ data: [] });
    renderPage();

    expect(await screen.findByText("history.empty")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "history.refresh" }));

    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("shows error state when fetch fails", async () => {
    mockGet.mockRejectedValueOnce(new Error("boom"));
    renderPage();
    expect(await screen.findByText("history.error")).toBeInTheDocument();
  });
});
