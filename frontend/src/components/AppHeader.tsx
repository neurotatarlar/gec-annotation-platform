import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { AppLogo } from "./AppLogo";
import { LanguageSwitcher } from "./LanguageSwitcher";

interface Profile {
  username: string;
  full_name?: string | null;
}

export const AppHeader = () => {
  const { logout, token } = useAuth();
  const { t } = useI18n();
  const api = useAuthedApi();

  const { data: profile } = useQuery<Profile>({
    queryKey: ["me"],
    queryFn: async () => {
      const response = await api.get("/api/auth/me");
      return response.data;
    },
    enabled: Boolean(token)
  });

  return (
    <header className="mb-6 flex min-h-[68px] flex-wrap items-center justify-between gap-3 rounded-3xl border border-slate-800 bg-slate-900/70 px-4 py-3">
      <div className="flex items-center gap-3">
        <AppLogo />
        {profile && (
          <div className="text-left">
            <p className="text-sm font-semibold text-slate-100">{profile.full_name || profile.username}</p>
            <p className="text-xs text-slate-400">@{profile.username}</p>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <LanguageSwitcher />
        <Link
          to="/history"
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-100 hover:border-emerald-400 hover:text-emerald-100"
        >
          {t("common.history")}
        </Link>
        <Link
          to="/settings"
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-100 hover:border-emerald-400 hover:text-emerald-100"
        >
          {t("common.settings")}
        </Link>
        <button
          className="rounded-lg border border-rose-500/60 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/20"
          onClick={logout}
        >
          {t("common.logout")}
        </button>
      </div>
    </header>
  );
};
