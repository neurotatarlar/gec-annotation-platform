import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { HistoryItem } from "../types";

const HISTORY_LIMIT = 50;

export const HistoryPage = () => {
  const api = useAuthedApi();
  const { t } = useI18n();
  const navigate = useNavigate();

  const {
    data: items = [],
    isLoading,
    isError,
    refetch,
    isRefetching
  } = useQuery<HistoryItem[]>({
    queryKey: ["history", HISTORY_LIMIT],
    queryFn: async () => {
      const response = await api.get("/api/texts/history", { params: { limit: HISTORY_LIMIT } });
      return response.data;
    }
  });

  return (
    <div className="flex flex-col gap-4 text-right">
      <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-6 text-left">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">{t("history.title")}</h1>
            <p className="text-sm text-slate-400">{t("history.subtitle")}</p>
          </div>
          <button
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-100 disabled:opacity-50"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            {isRefetching ? t("history.refreshing") : t("history.refresh")}
          </button>
        </div>
      </div>
      <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-6 text-left">
        {isLoading ? (
          <p className="text-sm text-slate-300">{t("common.loading")}</p>
        ) : isError ? (
          <p className="text-sm text-rose-300">{t("history.error")}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-slate-300">{t("history.empty")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((item) => (
              <div
                key={`${item.text_id}-${item.updated_at}`}
                className="rounded-2xl border border-slate-800/70 bg-slate-950/40 px-4 py-3 text-right"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-left">
                    <p className="text-sm font-semibold text-slate-100">
                      #{item.text_id} · {item.status}
                    </p>
                    <p className="text-xs text-slate-500">{new Date(item.updated_at).toLocaleString()}</p>
                  </div>
                  <button
                    className="rounded-lg border border-emerald-400/50 px-3 py-1 text-xs text-emerald-100"
                    onClick={() => navigate(`/annotate/${item.text_id}`)}
                  >
                    {t("history.open")}
                  </button>
                </div>
                <p className="mt-2 text-sm text-slate-300 leading-relaxed">{item.preview || "…"}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
