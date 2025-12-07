import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";
import {
  ActivityItem,
  AnnotatorSummary,
  CategorySummary,
  DashboardStats,
  PaginatedActivity
} from "../types";

const PAGE_SIZE = 30;

const toIsoDate = (value: string, isEnd?: boolean) => {
  if (!value) return undefined;
  const suffix = isEnd ? "T23:59:59.999Z" : "T00:00:00.000Z";
  return `${value}${suffix}`;
};

const combinePages = <T,>(pages: Array<{ items: T[] } | undefined>) =>
  pages?.flatMap((page) => page?.items ?? []) ?? [];

export const DashboardPage = () => {
  const api = useAuthedApi();
  const { t } = useI18n();

  const [selectedCategories, setSelectedCategories] = useState<number[]>([]);
  const [selectedAnnotators, setSelectedAnnotators] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showSkip, setShowSkip] = useState(true);
  const [showTrash, setShowTrash] = useState(true);
  const [showSubmitted, setShowSubmitted] = useState(true);
  const [sortField, setSortField] = useState("occurred_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const { data: categories = [] } = useQuery<CategorySummary[]>({
    queryKey: ["categories"],
    queryFn: async () => {
      const response = await api.get("/api/categories/");
      return response.data;
    }
  });

  const { data: annotators = [] } = useQuery<AnnotatorSummary[]>({
    queryKey: ["dashboard", "annotators"],
    queryFn: async () => {
      const response = await api.get("/api/dashboard/annotators");
      return response.data;
    }
  });

  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["dashboard", "stats"],
    queryFn: async () => {
      const response = await api.get("/api/dashboard/stats");
      return response.data;
    },
    refetchInterval: 60_000
  });

  const sharedParams = useMemo(
    () => ({
      category_ids: selectedCategories.join(",") || undefined,
      annotator_ids: selectedAnnotators.join(",") || undefined,
      start: toIsoDate(dateFrom),
      end: toIsoDate(dateTo, true)
    }),
    [selectedAnnotators, selectedCategories, dateFrom, dateTo]
  );

  const activityQuery = useInfiniteQuery<PaginatedActivity>({
    queryKey: [
      "dashboard",
      "activity",
      sharedParams.category_ids,
      sharedParams.annotator_ids,
      sharedParams.start,
      sharedParams.end,
      search,
      showSkip,
      showTrash,
      showSubmitted,
      sortField,
      sortOrder
    ],
    getNextPageParam: (last) => last?.next_offset ?? undefined,
    queryFn: async ({ pageParam = 0 }) => {
      const kinds: string[] = [];
      if (showSkip) kinds.push("skip");
      if (showTrash) kinds.push("trash");
      if (showSubmitted) kinds.push("task");

      const taskStatuses: string[] = [];
      if (showSubmitted) taskStatuses.push("submitted");

      const response = await api.get("/api/dashboard/activity", {
        params: {
          ...sharedParams,
          kinds: kinds.join(",") || undefined,
          query: search || undefined,
          task_statuses: taskStatuses.length ? taskStatuses.join(",") : undefined,
          sort: sortField,
          order: sortOrder,
          limit: PAGE_SIZE,
          offset: pageParam
        }
      });
      return response.data;
    }
  });

  const activityItems = combinePages<ActivityItem>(activityQuery.data?.pages);

  useEffect(() => {
    if (!activityQuery.hasNextPage || activityQuery.isFetchingNextPage) return;
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && activityQuery.hasNextPage && !activityQuery.isFetchingNextPage) {
          activityQuery.fetchNextPage();
        }
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [activityQuery]);

  const renderChipGroup = <T extends string | number>({
    label,
    options,
    value,
    onChange
  }: {
    label: string;
    options: Array<{ label: string; value: T }>;
    value: T[];
    onChange: (next: T[]) => void;
  }) => {
    const toggle = (val: T) => {
      const exists = value.includes(val);
      onChange(exists ? value.filter((item) => item !== val) : [...value, val]);
    };
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
        <span className="text-xs uppercase tracking-wide text-slate-400">{label}</span>
        {options.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">{t("dashboard.empty")}</p>
        ) : (
          <div className="mt-3 flex max-h-32 flex-wrap gap-2 overflow-y-auto pr-1">
            {options.map((opt) => {
              const active = value.includes(opt.value);
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => toggle(opt.value)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                    active
                      ? "border-emerald-400/80 bg-emerald-500/15 text-emerald-100"
                      : "border-slate-700 text-slate-200 hover:border-slate-500"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderDateInputs = (
    <div className="grid grid-cols-2 gap-3">
      <label className="flex flex-col gap-1 text-sm text-slate-200">
        <span className="text-xs uppercase tracking-wide text-slate-400">{t("dashboard.dateFrom")}</span>
        <input
          type="date"
          value={dateFrom}
          className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 text-sm text-slate-100"
          onChange={(event) => setDateFrom(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-slate-200">
        <span className="text-xs uppercase tracking-wide text-slate-400">{t("dashboard.dateTo")}</span>
        <input
          type="date"
          value={dateTo}
          className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 text-sm text-slate-100"
          onChange={(event) => setDateTo(event.target.value)}
        />
      </label>
    </div>
  );

  const categoryOptions = useMemo(
    () => categories.map((item) => ({ value: item.id, label: item.name })),
    [categories]
  );
  const annotatorOptions = useMemo(
    () =>
      annotators.map((user) => ({
        value: user.id,
        label: user.full_name ? `${user.full_name} (@${user.username})` : user.username
      })),
    [annotators]
  );

  const renderSortControls = ({
    sort,
    order,
    options,
    onSortChange,
    onOrderChange
  }: {
    sort: string;
    order: "asc" | "desc";
    options: Array<{ value: string; label: string }>;
    onSortChange: (value: string) => void;
    onOrderChange: (value: "asc" | "desc") => void;
  }) => (
    <div className="flex flex-wrap gap-3 text-sm text-slate-200">
      <label className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-slate-400">{t("dashboard.sortBy")}</span>
        <select
          value={sort}
          onChange={(event) => onSortChange(event.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-slate-400">{t("dashboard.sortOrder")}</span>
        <select
          value={order}
          onChange={(event) => onOrderChange(event.target.value as "asc" | "desc")}
          className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm"
        >
          <option value="desc">{t("dashboard.orderDesc")}</option>
          <option value="asc">{t("dashboard.orderAsc")}</option>
        </select>
      </label>
    </div>
  );

  const renderActivityCard = (item: ActivityItem) => {
    const isFlag = item.kind === "skip" || item.kind === "trash";
    const tone =
      item.kind === "skip"
        ? {
            badge: "bg-violet-500/10 text-violet-100",
            halo: "from-violet-500/20 via-slate-900/60 to-slate-900/40"
          }
        : item.kind === "trash"
          ? {
              badge: "bg-rose-500/10 text-rose-100",
              halo: "from-rose-500/20 via-slate-900/60 to-slate-900/40"
            }
          : {
              badge: "bg-emerald-500/10 text-emerald-100",
              halo: "from-emerald-500/20 via-slate-900/60 to-slate-900/40"
            };
    const badge =
      item.kind === "skip"
        ? t("dashboard.flaggedSkip")
        : item.kind === "trash"
          ? t("dashboard.flaggedTrash")
          : item.status || "task";
    const focusAction =
      item.kind === "skip" ? "skip" : item.kind === "trash" ? "trash" : item.status === "submitted" ? "submit" : null;

    return (
      <article
        key={`${item.kind}-${item.id}-${item.occurred_at}`}
        className="overflow-hidden rounded-2xl border border-slate-800/70 bg-gradient-to-br from-slate-950 via-slate-900/70 to-slate-950 text-right shadow-[0_10px_40px_-25px_rgba(0,0,0,0.7)]"
      >
        <div className={`h-1 w-full bg-gradient-to-r ${tone.halo}`} aria-hidden />
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
          <div className="flex flex-wrap items-center gap-2 text-left">
            <span className={`rounded-lg px-3 py-1 text-[0.7rem] font-semibold uppercase ${tone.badge}`}>
              {badge}
            </span>
            <span className="rounded-lg bg-slate-800/60 px-3 py-1 text-xs font-semibold text-slate-100">{item.category.name}</span>
            <span className="rounded-lg bg-slate-800/40 px-3 py-1 text-xs text-slate-200">
              {item.annotator.full_name || item.annotator.username}
            </span>
            <span className="rounded-lg bg-slate-800/40 px-3 py-1 text-[0.7rem] text-slate-400">
              {new Date(item.occurred_at).toLocaleString()}
            </span>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/annotate/${item.text_id}${focusAction ? `?focusAction=${focusAction}` : ""}`)}
            className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-100 transition hover:border-emerald-300 hover:bg-emerald-500/20"
          >
            {t("history.open")}
          </button>
        </div>
        <p className="mt-3 border-t border-slate-800/60 bg-slate-950/40 px-4 py-3 text-left text-sm leading-relaxed text-slate-200">
          {item.text_preview || "…"}
        </p>
      </article>
    );
  };

  return (
    <div className="flex flex-col gap-6 text-right">
      <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-left">
            <h1 className="text-2xl font-semibold text-slate-100">{t("dashboard.title")}</h1>
            <p className="text-sm text-slate-400">{t("dashboard.subtitle")}</p>
          </div>
          {stats && (
            <p className="text-xs text-slate-500">
              {t("dashboard.lastUpdated", { date: new Date(stats.last_updated).toLocaleTimeString() })}
            </p>
          )}
        </div>
        {stats && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-left">
              <p className="text-xs uppercase tracking-wide text-slate-400">{t("dashboard.totalTexts")}</p>
              <p className="mt-1 text-2xl font-semibold text-slate-100">{stats.total_texts}</p>
              <p className="text-xs text-slate-400">{t("dashboard.completedCount", { count: stats.completed_texts })}</p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-left">
              <p className="text-xs uppercase tracking-wide text-slate-400">{t("dashboard.pending")}</p>
              <p className="mt-1 text-2xl font-semibold text-amber-100">{stats.pending_texts}</p>
              <p className="text-xs text-slate-400">{t("dashboard.inAnnotation", { count: stats.in_annotation_texts })}</p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-left">
              <p className="text-xs uppercase tracking-wide text-slate-400">{t("dashboard.awaiting")}</p>
              <p className="mt-1 text-2xl font-semibold text-sky-100">{stats.awaiting_review_texts}</p>
              <p className="text-xs text-slate-400">
                {t("dashboard.submittedCount", { count: stats.submitted_tasks })}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-left">
              <p className="text-xs uppercase tracking-wide text-slate-400">{t("dashboard.flags")}</p>
              <p className="mt-1 text-2xl font-semibold text-rose-100">
                {stats.skipped_count + stats.trashed_count}
              </p>
              <p className="text-xs text-slate-400">
                {t("dashboard.flagBreakdown", { skip: stats.skipped_count, trash: stats.trashed_count })}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-300">{t("dashboard.subtitle")}</p>
          <button
            className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-100"
            onClick={() => {
              setSelectedCategories([]);
              setSelectedAnnotators([]);
              setDateFrom("");
              setDateTo("");
              setSearch("");
            }}
          >
            {t("dashboard.clearFilters")}
          </button>
        </div>
        <div className="grid gap-4 lg:grid-cols-[2fr_2fr_1fr]">
          {renderChipGroup({
            label: t("dashboard.categories"),
            options: categoryOptions,
            value: selectedCategories,
            onChange: setSelectedCategories
          })}
          {renderChipGroup({
            label: t("dashboard.annotators"),
            options: annotatorOptions,
            value: selectedAnnotators,
            onChange: setSelectedAnnotators
          })}
          <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
            <span className="text-xs uppercase tracking-wide text-slate-400">{t("dashboard.dateFrom")}</span>
            {renderDateInputs}
            <label className="mt-2 flex flex-col gap-1 text-sm text-slate-200">
              <span className="text-xs uppercase tracking-wide text-slate-400">{t("dashboard.searchText")}</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("dashboard.searchPlaceholder")}
                className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 text-sm text-slate-100"
              />
            </label>
          </div>
        </div>
      </div>

      <section className="rounded-3xl border border-slate-800 bg-slate-900/80 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                showSkip ? "border border-violet-400/80 bg-violet-500/10 text-violet-100" : "border border-slate-700 text-slate-300"
              }`}
              onClick={() => setShowSkip((v) => !v)}
            >
              {t("dashboard.flaggedSkip")}
            </button>
            <button
              className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                showTrash ? "border border-rose-400/80 bg-rose-500/10 text-rose-100" : "border border-slate-700 text-slate-300"
              }`}
              onClick={() => setShowTrash((v) => !v)}
            >
              {t("dashboard.flaggedTrash")}
            </button>
            <button
              className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                showSubmitted ? "border border-emerald-400/80 bg-emerald-500/10 text-emerald-100" : "border border-slate-700 text-slate-300"
              }`}
              onClick={() => setShowSubmitted((v) => !v)}
            >
              {t("dashboard.submittedTitle")}
            </button>
          </div>
          {renderSortControls({
            sort: sortField,
            order: sortOrder,
            options: [
              { value: "occurred_at", label: t("dashboard.sortUpdated") },
              { value: "category", label: t("dashboard.sortCategory") },
              { value: "annotator", label: t("dashboard.sortAnnotator") },
              { value: "text", label: t("dashboard.sortTextId") }
            ],
            onSortChange: setSortField,
            onOrderChange: setSortOrder
          })}
        </div>
        <div className="mt-4 space-y-3">
          {activityQuery.isLoading ? (
            <p className="text-sm text-slate-300">{t("common.loading")}</p>
          ) : activityItems.length === 0 ? (
            <p className="text-sm text-slate-300">{t("dashboard.empty")}</p>
          ) : (
            activityItems.map(renderActivityCard)
          )}
          <div ref={loadMoreRef} className="flex justify-center py-2 text-sm text-slate-400">
            {activityQuery.isFetchingNextPage
              ? t("common.loading")
              : activityQuery.hasNextPage
                ? t("dashboard.loadMore")
                : null}
          </div>
        </div>
      </section>
    </div>
  );
};
