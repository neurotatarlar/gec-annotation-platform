/**
 * Login screen with credential form and error handling.
 */
import { FormEvent, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import axios from "axios";

import { useAuth } from "../context/AuthContext";
import { AppLogo } from "../components/AppLogo";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { useI18n } from "../context/I18nContext";

export const LoginPage = () => {
  const { login } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasError, setHasError] = useState(false);
  const sessionMessage = useMemo(() => {
    const state = (location.state as { reason?: string } | null) ?? null;
    if (state?.reason === "session-expired") {
      return t("login.sessionExpired");
    }
    return null;
  }, [location.state, t]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const apiBase = (import.meta.env.VITE_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
      const tokenUrl = apiBase.endsWith("/api") ? `${apiBase}/auth/token` : `${apiBase}/api/auth/token`;
      const response = await axios.post(
        tokenUrl,
        new URLSearchParams({
          username,
          password
        }),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" }
        }
      );
      login(response.data.access_token);
    } catch (err) {
      setHasError(true);
      console.error(err);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <div className="absolute left-4 top-4">
        <AppLogo />
      </div>
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-2xl bg-slate-800/80 p-8 shadow-xl"
      >
        <header>
          <h1 className="text-2xl font-semibold">{t("login.title")}</h1>
          <p className="text-sm text-slate-300">{t("login.subtitle")}</p>
        </header>
        {sessionMessage && (
          <div className="rounded-lg border border-amber-400/70 bg-amber-500/10 px-3 py-2 text-sm text-amber-50">
            {sessionMessage}
          </div>
        )}
        <div className="space-y-2">
          <label className="text-sm text-slate-300" htmlFor="username">
            {t("login.username")}
          </label>
          <input
            id="username"
            autoFocus
            className="w-full rounded-lg border border-slate-600 bg-slate-900/70 px-3 py-2 focus:outline focus:outline-2 focus:outline-emerald-400"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setHasError(false);
            }}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm text-slate-300" htmlFor="password">
            {t("login.password")}
          </label>
          <input
            id="password"
            className="w-full rounded-lg border border-slate-600 bg-slate-900/70 px-3 py-2"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setHasError(false);
            }}
          />
        </div>
        {hasError && <p className="text-sm text-red-400">{t("login.error")}</p>}
        <button
          type="submit"
          className="w-full rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-slate-900 hover:bg-emerald-400"
        >
          {t("login.button")}
        </button>
      </form>
    </div>
  );
};
