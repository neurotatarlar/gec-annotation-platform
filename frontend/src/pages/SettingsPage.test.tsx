import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { SettingsPage } from "./SettingsPage";

const apiMocks = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
}));

const errorTypesState = vi.hoisted(() => ({ data: [] as any[] }));

const queryClientMocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

vi.mock("../api/client", () => ({
  useAuthedApi: () => ({
    get: apiMocks.mockGet,
    post: apiMocks.mockPost,
    put: apiMocks.mockPut,
  }),
}));

// Lightweight react-query mock to avoid hanging timers.
vi.mock("@tanstack/react-query", () => {
  const profileData = { id: "u1", username: "tester", role: "admin" };
  const useQuery = ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "error-types") {
      return { data: errorTypesState.data };
    }
    if (queryKey[0] === "me") {
      return { data: profileData };
    }
    return { data: undefined };
  };

  const useMutation = (opts: any) => ({
    mutate: (payload: any) =>
      Promise.resolve(opts.mutationFn(payload)).then((res) => {
        opts.onSuccess?.(res, payload, undefined);
        return res;
      }),
    mutateAsync: (payload: any) =>
      Promise.resolve(opts.mutationFn(payload)).then((res) => {
        opts.onSuccess?.(res, payload, undefined);
        return res;
      }),
    isPending: false,
  });

  const useQueryClient = () => queryClientMocks;
  const QueryClientProvider = ({ children }: { children: React.ReactNode }) => <>{children}</>;

  return { useQuery, useMutation, useQueryClient, QueryClientProvider };
});

describe("SettingsPage", () => {
  const setup = async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );
    await screen.findByText("settings.errorTypesHeader");
  };

  beforeEach(() => {
    apiMocks.mockGet.mockReset();
    apiMocks.mockPost.mockReset();
    apiMocks.mockPut.mockReset();
    queryClientMocks.invalidateQueries.mockReset();
    errorTypesState.data = [];
    apiMocks.mockGet.mockImplementation((url: string) => {
      if (url === "/api/error-types/") return Promise.resolve({ data: [] });
      if (url === "/api/auth/me") return Promise.resolve({ data: { id: "u1", username: "tester", role: "admin" } });
      throw new Error(`Unhandled GET ${url}`);
    });
    apiMocks.mockPost.mockResolvedValue({ data: { id: 123 } });
    apiMocks.mockPut.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it("sends create request when adding a new error type", async () => {
    await setup();

    fireEvent.click(screen.getByText("settings.addButton"));
    const nameInput = await screen.findByPlaceholderText("settings.enNameLabel");
    fireEvent.change(nameInput, { target: { value: " New type " } });
    fireEvent.click(screen.getByText("settings.add"));

    await waitFor(() => expect(apiMocks.mockPost).toHaveBeenCalledTimes(1));
    expect(apiMocks.mockPost).toHaveBeenCalledWith("/api/error-types/", {
      description: null,
      sort_order: null,
      default_color: "#f97316",
      default_hotkey: null,
      category_en: null,
      category_tt: null,
      en_name: "New type",
      tt_name: null,
      is_active: true,
    });
  });

  it("validates password confirmation when saving profile", async () => {
    await setup();
    const username = await screen.findByDisplayValue("tester");
    const [password, confirm] = await screen.findAllByPlaceholderText("settings.profilePasswordPlaceholder");

    fireEvent.change(username, { target: { value: "tester" } });
    fireEvent.change(password, { target: { value: "secret" } });
    fireEvent.change(confirm, { target: { value: "other" } });

    const saveButton = screen.getByText("settings.profileSave");
    expect(saveButton).toBeDisabled();
    expect(apiMocks.mockPut).not.toHaveBeenCalled();
  });

  it("reorders error types within a category and persists sort order", async () => {
    errorTypesState.data = [
      {
        id: 1,
        en_name: "Alpha",
        tt_name: "Alpha",
        category_en: "Grammar",
        category_tt: "Грамматика",
        default_color: "#111111",
        default_hotkey: "",
        sort_order: 1,
        is_active: true,
      },
      {
        id: 2,
        en_name: "Beta",
        tt_name: "Beta",
        category_en: "Grammar",
        category_tt: "Грамматика",
        default_color: "#222222",
        default_hotkey: "",
        sort_order: 2,
        is_active: true,
      },
    ];
    await setup();

    const alphaLabel = await screen.findByText(/Alpha/);
    const betaLabel = await screen.findByText(/Beta/);
    const alphaRow = alphaLabel.closest("tr");
    const betaRow = betaLabel.closest("tr");
    if (!alphaRow || !betaRow) throw new Error("Missing rows for drag test");
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn(),
      getData: vi.fn(),
    };

    fireEvent.dragStart(alphaRow, { dataTransfer });
    fireEvent.dragOver(betaRow, { dataTransfer });
    fireEvent.drop(betaRow, { dataTransfer });
    fireEvent.dragEnd(alphaRow, { dataTransfer });

    fireEvent.click(screen.getByText("common.save"));
    await waitFor(() => expect(apiMocks.mockPut).toHaveBeenCalled());
    expect(apiMocks.mockPut.mock.calls).toEqual(
      expect.arrayContaining([
        ["/api/error-types/1", expect.objectContaining({ sort_order: 2 })],
        ["/api/error-types/2", expect.objectContaining({ sort_order: 1 })],
      ])
    );
  });

  it("invalidates error types cache when navigating back", async () => {
    await setup();
    fireEvent.click(screen.getByText("common.back"));
    expect(queryClientMocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["error-types"] });
  });
});
