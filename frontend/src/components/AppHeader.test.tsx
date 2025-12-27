import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppHeader } from "./AppHeader";
import { SaveStatusProvider, useSaveStatus } from "../context/SaveStatusContext";

const getMock = vi.fn((url: string) => {
  if (url.includes("/api/auth/me")) {
    return Promise.resolve({ data: { username: "alice", full_name: "Alice" } });
  }
  if (url.includes("/api/categories")) {
    return Promise.resolve({ data: [] });
  }
  return Promise.resolve({ data: {} });
});

const logoutMock = vi.fn();

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ token: "token", logout: logoutMock }),
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../api/client", () => ({
  useAuthedApi: () => ({
    get: getMock,
  }),
}));

const StatusSetter = ({ state, unsaved }: { state: "idle" | "saving" | "saved" | "error"; unsaved: boolean }) => {
  const { setStatus } = useSaveStatus();
  useEffect(() => {
    setStatus({ state, unsaved });
  }, [setStatus, state, unsaved]);
  return null;
};

const renderHeader = (path = "/annotate/1", status?: { state: "idle" | "saving" | "saved" | "error"; unsaved: boolean }) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, cacheTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SaveStatusProvider>
          {status ? <StatusSetter state={status.state} unsaved={status.unsaved} /> : null}
          <AppHeader />
        </SaveStatusProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

afterEach(() => {
  cleanup();
});

describe("AppHeader save status indicator", () => {
  it("shows status next to user info on annotation page", async () => {
    renderHeader("/annotate/42", { state: "saving", unsaved: true });
    await screen.findAllByText("Alice");
    const status = await screen.findByTitle("common.saving");
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent("⏳");
  });

  it("renders unsaved dot when there are pending changes", async () => {
    renderHeader("/annotate/1", { state: "idle", unsaved: true });
    await screen.findAllByText("Alice");
    const status = await screen.findByTitle("common.unsaved");
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent("●");
  });

  it("hides status on non-annotation pages", async () => {
    renderHeader("/history");
    await screen.findAllByText("Alice");
    expect(screen.queryByTitle("common.saving")).not.toBeInTheDocument();
    expect(screen.queryByText("⏳")).not.toBeInTheDocument();
  });

  it("opens export modal when clicking export button", async () => {
    renderHeader("/dashboard", { state: "idle", unsaved: false });
    await screen.findAllByText("Alice");
    const exportBtn = screen.getAllByText("export.open")[0];
    fireEvent.click(exportBtn);
    expect(await screen.findByText("export.title")).toBeInTheDocument();
  });

  it("shows logout confirmation modal and closes on Escape", async () => {
    renderHeader("/dashboard");
    await screen.findAllByText("Alice");
    const logoutBtn = screen.getAllByText("common.logout")[0];
    fireEvent.click(logoutBtn);
    expect(await screen.findByText("common.logoutConfirmTitle")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("common.logoutConfirmTitle")).not.toBeInTheDocument();
  });

  it("calls logout on confirmation", async () => {
    logoutMock.mockClear();
    renderHeader("/dashboard");
    await screen.findAllByText("Alice");
    const logoutBtn = screen.getAllByText("common.logout")[0];
    fireEvent.click(logoutBtn);
    const confirm = await screen.findAllByText("common.logout");
    fireEvent.click(confirm[1]);
    expect(logoutMock).toHaveBeenCalledTimes(1);
  });
});
