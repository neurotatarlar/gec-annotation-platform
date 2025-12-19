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
  const errorTypesData: any[] = [];
  const profileData = { id: "u1", username: "tester", role: "admin" };
  const useQuery = ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "error-types") {
      return { data: errorTypesData };
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

  const useQueryClient = () => ({ invalidateQueries: vi.fn() });
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
});
