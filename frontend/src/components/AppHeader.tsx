import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useMemo, useState } from "react";

import { useAuthedApi } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { useSaveStatus } from "../context/SaveStatusContext";
import { AppLogo } from "./AppLogo";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useLocation } from "react-router-dom";
import { CategorySummary } from "../types";

interface Profile {
  username: string;
  full_name?: string | null;
  id?: string;
}

export const AppHeader = () => {
  const { logout, token } = useAuth();
  const { t } = useI18n();
  const api = useAuthedApi();
  const { status } = useSaveStatus();
  const location = useLocation();
  const [showExport, setShowExport] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<number[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const { data: profile } = useQuery<Profile>({
    queryKey: ["me"],
    queryFn: async () => {
      const response = await api.get("/api/auth/me");
      return response.data;
    },
    enabled: Boolean(token)
  });

  const { data: categories = [] } = useQuery<CategorySummary[]>({
    queryKey: ["categories", "export"],
    queryFn: async () => {
      const response = await api.get("/api/categories/");
      return response.data;
    },
    enabled: showExport && Boolean(token)
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

  const toggleCategory = (id: number) => {
    setSelectedCategories((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const downloadExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const params: Record<string, string> = {};
      if (selectedCategories.length) {
        params.category_ids = selectedCategories.join(",");
      }
      if (startDate) {
        params.start = new Date(startDate).toISOString();
      }
      if (endDate) {
        params.end = new Date(endDate).toISOString();
      }
      const response = await api.get("/api/texts/export", { params, responseType: "blob" });
      const blob = new Blob([response.data], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `export_${Date.now()}.m2`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setShowExport(false);
    } catch (error: any) {
      setExportError(error?.response?.data?.detail ?? t("export.error"));
    } finally {
      setExporting(false);
    }
  };

  const categoryChips = useMemo(
    () =>
      categories.map((cat) => {
        const active = selectedCategories.includes(cat.id);
        return (
          <button
            key={cat.id}
            type="button"
            onClick={() => toggleCategory(cat.id)}
            className={`rounded-full border px-3 py-1 text-sm ${
              active
                ? "border-emerald-400 bg-emerald-400/10 text-emerald-100"
                : "border-slate-700 bg-slate-800/60 text-slate-200 hover:border-slate-500"
            }`}
          >
            {cat.name}
          </button>
        );
      }),
    [categories, selectedCategories]
  );

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
          to="/dashboard"
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-100 hover:border-emerald-400 hover:text-emerald-100"
        >
          {t("dashboard.title")}
        </Link>
        <Link
          to="/settings"
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-100 hover:border-emerald-400 hover:text-emerald-100"
        >
          {t("common.settings")}
        </Link>
        <button
          className="rounded-lg border border-emerald-500/60 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/10"
          onClick={() => setShowExport(true)}
        >
          {t("export.open")}
        </button>
        <button
          className="rounded-lg border border-rose-500/60 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/20"
          onClick={logout}
        >
          {t("common.logout")}
        </button>
      </div>
      {showExport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-950/90 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-100">{t("export.title")}</h3>
                <p className="text-sm text-slate-400">{t("export.subtitle")}</p>
              </div>
              <button
                className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-100"
                onClick={() => setShowExport(false)}
              >
                {t("common.cancel")}
              </button>
            </div>
            <div className="mt-4 space-y-4">
              <div>
                <p className="text-sm font-semibold text-slate-200">{t("export.format")}</p>
                <p className="text-xs text-slate-500">{t("export.submittedOnly")}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-200">{t("export.categories")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {categories.length ? categoryChips : <span className="text-sm text-slate-500">{t("common.none")}</span>}
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <label className="text-sm text-slate-300">{t("common.dateFrom")}</label>
                  <input
                    type="datetime-local"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-900/40 px-3 py-2 text-slate-100"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm text-slate-300">{t("common.dateTo")}</label>
                  <input
                    type="datetime-local"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-900/40 px-3 py-2 text-slate-100"
                  />
                </div>
              </div>
              {exportError && <div className="rounded-lg border border-rose-500/70 bg-rose-500/10 px-3 py-2 text-rose-100">{exportError}</div>}
              <div className="flex justify-end gap-3">
                <button
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200"
                  onClick={() => setShowExport(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-60"
                  disabled={exporting}
                  onClick={downloadExport}
                >
                  {exporting ? t("export.preparing") : t("export.download")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
