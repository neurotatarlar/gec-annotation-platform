import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { CategorySummary, FlaggedTextEntry } from "../types";

export const FlaggedTextsPage = () => {
  const api = useAuthedApi();
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { categoryId, flagType } = useParams<{ categoryId: string; flagType: string }>();

  const normalizedFlag = flagType === "trash" ? "trash" : "skip";
  const numericCategoryId = Number(categoryId);

  const formatDateTime = (iso: string) => {
    const date = new Date(iso);
    const pad = (value: number) => value.toString().padStart(2, "0");
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const { data: categories } = useQuery<CategorySummary[]>({
    queryKey: ["categories"],
    queryFn: async () => {
      const response = await api.get("/api/categories/");
      return response.data;
    }
  });

  const category = useMemo(
    () => categories?.find((item) => item.id === numericCategoryId),
    [categories, numericCategoryId]
  );

  const {
    data: entries = [],
    isLoading,
    isError
  } = useQuery<FlaggedTextEntry[]>({
    queryKey: ["flagged", normalizedFlag, numericCategoryId],
    enabled: !Number.isNaN(numericCategoryId),
    queryFn: async () => {
      const response = await api.get("/api/texts/flags", {
        params: { flag_type: normalizedFlag, category_id: numericCategoryId }
      });
      return response.data;
    }
  });

  const unflagMutation = useMutation({
    mutationFn: async (textId: number) => {
      const endpoint = normalizedFlag === "trash" ? "trash" : "skip";
      await api.delete(`/api/texts/${textId}/${endpoint}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flagged", normalizedFlag, numericCategoryId] });
      queryClient.invalidateQueries({ queryKey: ["skipped"] });
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    }
  });

  const title =
    normalizedFlag === "trash"
      ? t("flags.subtitleTrash", { name: category?.name ?? "…" })
      : t("flags.subtitleSkip", { name: category?.name ?? "…" });

  const handleNavigateBack = () => {
    navigate("/");
  };

  const handleBadgeNavigate = (targetFlag: "skip" | "trash") => {
    navigate(`/categories/${categoryId}/flags/${targetFlag}`);
  };

  if (Number.isNaN(numericCategoryId)) {
    return <p className="p-6 text-center text-rose-200">{t("flags.invalidCategory")}</p>;
  }

  return (
    <div className="flex flex-col gap-6 text-right">
      <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200"
              onClick={handleNavigateBack}
            >
              {t("common.back")}
            </button>
            <div className="text-right">
              <p className="text-lg font-semibold text-slate-100">{t("flags.title")}</p>
              <p className="text-sm text-slate-400">{title}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                normalizedFlag === "skip"
                  ? "border border-violet-400 text-violet-100"
                  : "border border-slate-700 text-slate-400"
              }`}
              onClick={() => handleBadgeNavigate("skip")}
            >
              {t("flags.tabSkip")}
            </button>
            <button
              className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                normalizedFlag === "trash"
                  ? "border border-rose-400 text-rose-100"
                  : "border border-slate-700 text-slate-400"
              }`}
              onClick={() => handleBadgeNavigate("trash")}
            >
              {t("flags.tabTrash")}
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-6">
        {isLoading ? (
          <p className="text-sm text-slate-300">{t("common.loading")}</p>
        ) : isError ? (
          <p className="text-sm text-rose-300">{t("flags.error")}</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-slate-300">{t("flags.empty")}</p>
        ) : (
          <div className="space-y-4">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-2xl border border-slate-800/70 bg-slate-950/50 p-4 text-right"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-right">
                    <p className="text-sm text-slate-500">
                      {t("flags.created", {
                        date: formatDateTime(entry.created_at)
                      })}
                    </p>
                    {entry.reason && (
                      <p className="text-xs text-slate-400">{t("flags.reason", { reason: entry.reason })}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="rounded-lg border border-slate-600 px-3 py-1 text-xs text-slate-200"
                      onClick={() => navigate(`/annotate/${entry.text.id}`)}
                    >
                      {t("flags.open")}
                    </button>
                    <button
                      className="rounded-lg border border-emerald-500/60 px-3 py-1 text-xs font-semibold text-emerald-100 disabled:opacity-50"
                      onClick={() => unflagMutation.mutate(entry.text.id)}
                      disabled={unflagMutation.isPending}
                    >
                      {t("flags.restore")}
                    </button>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-slate-100">{entry.text.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
