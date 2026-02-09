import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import axios from "axios";

import { LoginPage } from "./LoginPage";

const loginMock = vi.fn();

vi.mock("axios");
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ login: loginMock }),
}));
vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));
vi.mock("../components/AppLogo", () => ({
  AppLogo: () => <div data-testid="app-logo" />,
}));
vi.mock("../components/LanguageSwitcher", () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}));

const mockedAxios = vi.mocked(axios, true);

const renderPage = (state?: unknown) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: "/login", state } as any]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
      </Routes>
    </MemoryRouter>
  );

describe("LoginPage", () => {
  beforeEach(() => {
    loginMock.mockReset();
    mockedAxios.post.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows session-expired message from route state", async () => {
    renderPage({ reason: "session-expired" });
    expect(await screen.findByText("login.sessionExpired")).toBeInTheDocument();
  });

  it("submits credentials and logs in on success", async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: "token-123" } } as any);
    renderPage();

    fireEvent.change(screen.getByLabelText("login.username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("login.password"), { target: { value: "Password123!" } });
    fireEvent.click(screen.getByRole("button", { name: "login.button" }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(1));
    const [url, body, config] = mockedAxios.post.mock.calls[0];
    expect(url).toContain("/api/auth/token");
    expect((body as URLSearchParams).toString()).toContain("username=alice");
    expect((body as URLSearchParams).toString()).toContain("password=Password123%21");
    expect(config).toMatchObject({
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(loginMock).toHaveBeenCalledWith("token-123");
  });

  it("shows error when login request fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockedAxios.post.mockRejectedValueOnce(new Error("bad credentials"));
    renderPage();

    fireEvent.change(screen.getByLabelText("login.username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("login.password"), { target: { value: "wrong" } });
    fireEvent.submit(screen.getByRole("button", { name: "login.button" }));

    expect(await screen.findByText("login.error")).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });
});
