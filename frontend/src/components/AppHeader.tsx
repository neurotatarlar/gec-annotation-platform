import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { useSaveStatus } from "../context/SaveStatusContext";
import { AppLogo } from "./AppLogo";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useLocation } from "react-router-dom";

interface Profile {
  username: string;
  full_name?: string | null;
}

export const AppHeader = () => {
  const { logout, token } = useAuth();
  const { t } = useI18n();
  const api = useAuthedApi();
  const { status } = useSaveStatus();
  const location = useLocation();

  const { data: profile } = useQuery<Profile>({
    queryKey: ["me"],
    queryFn: async () => {
      const response = await api.get("/api/auth/me");
      return response.data;
    },
    enabled: Boolean(token)
  });

  const isSaving = status?.state === "saving";
  const isError = status?.state === "error";
  const isUnsaved = status?.unsaved && !isSaving && !isError;
  const isSaved = status && !isSaving && !isError && !status.unsaved;

  const statusIcon = isSaving ? "⏳" : isError ? "⚠" : isUnsaved ? "●" : isSaved ? "✔" : null;
  const statusColor = isSaving
    ? "text-amber-300"
    : isError
      ? "text-rose-300"
      : isUnsaved
        ? "text-amber-400"
        : "text-emerald-300";
  const statusTitle = isSaving
    ? t("common.saving")
    : isError
      ? t("common.error")
      : isUnsaved
        ? t("common.unsaved")
        : isSaved
          ? t("common.saved")
          : null;
  const showStatus = location.pathname.startsWith("/annotate") && Boolean(status);

  return (
    <header className="mb-6 flex min-h-[68px] flex-wrap items-center justify-between gap-3 rounded-3xl border border-slate-800 bg-slate-900/70 px-4 py-3">
      <div className="flex items-center gap-3">
        <AppLogo />
        {profile && (
          <div className="text-left flex items-center gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-100">{profile.full_name || profile.username}</p>
              <p className="text-xs text-slate-400">@{profile.username}</p>
            </div>
            {showStatus && statusIcon && (
              <div
                className={`flex h-8 min-w-[32px] items-center justify-center rounded-full bg-slate-800/70 px-2 ${statusColor}`}
                title={statusTitle ?? undefined}
              >
                <span className="text-base leading-none">{statusIcon}</span>
              </div>
            )}
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
