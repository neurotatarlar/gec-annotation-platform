import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" })
}));

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();

vi.mock("../api/client", () => ({
  useAuthedApi: () => ({
    get: mockGet,
    post: mockPost,
    put: mockPut
  })
}));

// Import after mocks so hooks are intercepted correctly.
import { SettingsPage } from "./SettingsPage";

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
};

describe("SettingsPage error types", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/error-types/") {
        return Promise.resolve({ data: [] });
      }
      if (url === "/api/auth/me") {
        return Promise.resolve({ data: { id: "u1", username: "tester", role: "admin" } });
      }
      throw new Error(`Unhandled GET ${url}`);
    });
    mockPost.mockResolvedValue({ data: { id: 123 } });
  });

  it("sends create request when adding a new error type", async () => {
    renderPage();
    await screen.findByText("settings.errorTypesHeader");

    fireEvent.click(screen.getByText("settings.addButton"));
    const nameInput = await screen.findByPlaceholderText("settings.enNameLabel");
    fireEvent.change(nameInput, { target: { value: " New type " } });

    fireEvent.click(screen.getByText("settings.add"));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith("/api/error-types/", {
      description: null,
      default_color: "#f97316",
      default_hotkey: null,
      category_en: null,
      category_tt: null,
      en_name: "New type",
      tt_name: null,
      is_active: true
    });
  });
});
