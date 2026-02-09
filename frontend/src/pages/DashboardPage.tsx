/**
 * Dashboard page showing annotation metrics, charts, and recent activity with filters.
 */
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
const storageKey = "dashboardFilters";
const sortOptions = ["occurred_at", "category", "annotator", "text"] as const;
type SortField = (typeof sortOptions)[number];

const toIsoDate = (value: string, isEnd?: boolean) => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const hasTime = trimmed.includes("T") || /\d{1,2}:\d{2}/.test(trimmed);
  const isIsoLike = /^\d{4}-\d{2}-\d{2}/.test(trimmed) && !trimmed.includes("/");

  if (isIsoLike) {
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) return undefined;
    if (!hasTime) {
      date.setHours(isEnd ? 23 : 0, isEnd ? 59 : 0, isEnd ? 59 : 0, isEnd ? 999 : 0);
    }
    return date.toISOString();
  }

  const [datePart, timePartRaw] = trimmed.split(/\s+/);
  const [day, month, year] = datePart.split(/[./-]/).map(Number);
  if (!day || !month || !year) return undefined;
  const [hour = 0, minute = 0] = (timePartRaw || "").split(":").map((v) => Number(v || 0));

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, isEnd ? 59 : 0, isEnd ? 999 : 0));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
};

const combinePages = <T,>(pages: Array<{ items: T[] } | undefined>) =>
  pages?.flatMap((page) => page?.items ?? []) ?? [];

const toDateTimeLocalValue = (value: string) => {
  const iso = toIsoDate(value);
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (val: number) => val.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

type DashboardFilters = {
  categories: number[];
  annotators: string[];
  dateFrom: string;
  dateTo: string;
  showSkip: boolean;
  showTrash: boolean;
  showSubmitted: boolean;
  sortField: SortField;
  sortOrder: "asc" | "desc";
  search: string;
};

const defaultFilters: DashboardFilters = {
  categories: [],
  annotators: [],
  dateFrom: "",
  dateTo: "",
  showSkip: true,
  showTrash: true,
  showSubmitted: true,
  sortField: "occurred_at",
  sortOrder: "desc",
  search: ""
};

const normalizeSortField = (value: string | undefined | null): SortField => {
  const candidate = (value ?? "").toString();
  return (sortOptions as readonly string[]).includes(candidate) ? (candidate as SortField) : "occurred_at";
};

const normalizeSortOrder = (value: string | undefined | null): "asc" | "desc" =>
  value === "asc" || value === "desc" ? value : "desc";

const formatStatusLabel = (status: string | null | undefined, t: (k: string, params?: any) => string) => {
  const normalized = (status ?? "").toString().trim().toLowerCase();
  if (!normalized) return "task";
  if (normalized === "submitted") return t("dashboard.submittedTitle");
  return status ?? "task";
};

const loadPersistedFilters = (): DashboardFilters | null => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return {
      categories: parsed.categories ?? [],
      annotators: parsed.annotators ?? [],
      dateFrom: parsed.dateFrom ?? "",
      dateTo: parsed.dateTo ?? "",
      showSkip: parsed.showSkip ?? true,
      showTrash: parsed.showTrash ?? true,
      showSubmitted: parsed.showSubmitted ?? true,
      sortField: normalizeSortField(parsed.sortField),
      sortOrder: normalizeSortOrder(parsed.sortOrder),
      search: parsed.search ?? ""
    };
  } catch {
    return null;
  }
};

export const DashboardPage = () => {
  const api = useAuthedApi();
  const { t, locale } = useI18n();
  const persisted = useMemo(() => ({ ...defaultFilters, ...(loadPersistedFilters() ?? {}) }), []);

  const formatDateTime = (iso: string) => {
    const date = new Date(iso);
    const pad = (value: number) => value.toString().padStart(2, "0");
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const [selectedCategories, setSelectedCategories] = useState<number[]>(persisted.categories);
  const [selectedAnnotators, setSelectedAnnotators] = useState<string[]>(persisted.annotators);
  const [dateFrom, setDateFrom] = useState(persisted.dateFrom);
  const [dateTo, setDateTo] = useState(persisted.dateTo);
  const [showSkip, setShowSkip] = useState(persisted.showSkip);
  const [showTrash, setShowTrash] = useState(persisted.showTrash);
  const [showSubmitted, setShowSubmitted] = useState(persisted.showSubmitted);
  const [sortField, setSortField] = useState(persisted.sortField);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(persisted.sortOrder);
  const [search, setSearch] = useState(persisted.search);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const payload = {
      categories: selectedCategories,
      annotators: selectedAnnotators,
      dateFrom,
      dateTo,
      showSkip,
      showTrash,
      showSubmitted,
      sortField,
      sortOrder,
      search
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }, [selectedCategories, selectedAnnotators, dateFrom, dateTo, showSkip, showTrash, showSubmitted, sortField, sortOrder, search]);

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
    initialPageParam: 0,
    keepPreviousData: true,
    getNextPageParam: (last) => last?.next_offset ?? undefined,
    queryFn: async ({ pageParam = 0 }) => {
      const kinds: string[] = [];
      if (showSkip) kinds.push("skip");
      if (showTrash) kinds.push("trash");
      if (showSubmitted) kinds.push("task");

      const taskStatuses: string[] = [];
      if (showSubmitted) taskStatuses.push("submitted");

       if (kinds.length === 0) {
         return { items: [], next_offset: null };
       }

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

  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const combinedActivityItems = useMemo(
    () => combinePages<ActivityItem>(activityQuery.data?.pages),
    [activityQuery.data]
  );

  useEffect(() => {
    if (combinedActivityItems.length > 0 || (!activityQuery.isFetching && activityQuery.data)) {
      setActivityItems(combinedActivityItems);
    }
  }, [combinedActivityItems, activityQuery.isFetching, activityQuery.data]);

  const isInitialLoading = activityQuery.isLoading && activityItems.length === 0;

  useEffect(() => {
    if (!activityQuery.hasNextPage || activityQuery.isFetchingNextPage) return;
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && activityQuery.hasNextPage && !activityQuery.isFetchingNextPage) {
            activityQuery.fetchNextPage();
          }
        });
      },
      { rootMargin: "200px 0px" }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [activityQuery.hasNextPage, activityQuery.isFetchingNextPage, activityQuery.fetchNextPage]);

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
        <span className="text-xs uppercase tracking-wide text-slate-400">{t("common.dateFrom")}</span>
        <input
          type="datetime-local"
          value={toDateTimeLocalValue(dateFrom)}
          className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 text-sm text-slate-100"
          onChange={(event) => setDateFrom(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-slate-200">
        <span className="text-xs uppercase tracking-wide text-slate-400">{t("common.dateTo")}</span>
        <input
          type="datetime-local"
          value={toDateTimeLocalValue(dateTo)}
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
        <span className="text-xs uppercase tracking-wide text-slate-400">{t("common.sortBy")}</span>
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
        <span className="text-xs uppercase tracking-wide text-slate-400">{t("common.sortOrder")}</span>
        <select
          value={order}
          onChange={(event) => onOrderChange(event.target.value as "asc" | "desc")}
          className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm"
        >
          <option value="desc">{t("common.orderDesc")}</option>
          <option value="asc">{t("common.orderAsc")}</option>
        </select>
      </label>
    </div>
  );

  const renderActivityCard = (item: ActivityItem, index: number) => {
    const tone =
      item.kind === "skip"
        ? { badge: "bg-violet-500/10 text-violet-100" }
        : item.kind === "trash"
          ? { badge: "bg-rose-500/10 text-rose-100" }
          : { badge: "bg-emerald-500/10 text-emerald-100" };
    const badge =
      item.kind === "skip"
        ? t("dashboard.flaggedSkip")
        : item.kind === "trash"
          ? t("dashboard.flaggedTrash")
          : formatStatusLabel(item.status, t);
    const focusAction =
      item.kind === "skip" ? "skip" : item.kind === "trash" ? "trash" : item.status === "submitted" ? "submit" : null;

    return (
      <div
        key={`${item.kind}-${item.id}-${item.occurred_at}`}
        className={`table-row ${index % 2 === 0 ? "bg-slate-900/60" : "bg-slate-900/50"} border-t border-slate-800/40 first:border-t-0`}
      >
        <div className="table-cell px-3 py-2 align-middle">
          <span className={`rounded-lg px-3 py-1 text-[0.7rem] font-semibold uppercase ${tone.badge} whitespace-nowrap`}>{badge}</span>
        </div>
        <div className="table-cell px-3 py-2 align-middle">
          <span className="rounded-lg bg-slate-800/60 px-3 py-1 text-xs font-semibold text-slate-100 whitespace-nowrap">
            {item.category.name}
          </span>
        </div>
        <div className="table-cell px-3 py-2 align-middle">
          <span className="rounded-lg bg-slate-800/40 px-3 py-1 text-xs text-slate-200 whitespace-nowrap">
            {item.annotator.full_name || item.annotator.username}
          </span>
        </div>
        <div className="table-cell px-3 py-2 align-middle">
          <span className="rounded-lg bg-slate-800/40 px-3 py-1 text-[0.7rem] text-slate-400 whitespace-nowrap">
            {formatDateTime(item.occurred_at)}
          </span>
        </div>
        <div className="table-cell px-3 py-2 align-middle">
          <p className="min-w-[200px] text-sm leading-relaxed text-slate-100">{item.text_preview || "…"}</p>
        </div>
        <div className="table-cell px-3 py-2 align-middle text-right">
          <button
            type="button"
            onClick={() => navigate(`/annotate/${item.text_id}${focusAction ? `?focusAction=${focusAction}` : ""}`)}
            className="rounded-lg border border-emerald-400/50 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-100 transition hover:border-emerald-300 hover:bg-emerald-500/20"
          >
            {t("history.open")}
          </button>
        </div>
      </div>
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
          {t("dashboard.lastUpdated", {
            date: formatDateTime(stats.last_updated)
          })}
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
            {t("common.clearFilters")}
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
            <span className="text-xs uppercase tracking-wide text-slate-400">{t("common.dateFrom")}</span>
            {renderDateInputs}
            <label className="mt-2 flex flex-col gap-1 text-sm text-slate-200">
              <span className="text-xs uppercase tracking-wide text-slate-400">{t("common.searchText")}</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("common.searchPlaceholder")}
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
          {isInitialLoading ? (
            <p className="text-sm text-slate-300">{t("common.loading")}</p>
          ) : activityItems.length === 0 ? (
            <p className="text-sm text-slate-300">{t("dashboard.empty")}</p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-800/60">
              <div className="table w-full border-collapse">
                {activityItems.map((item, index) => renderActivityCard(item, index))}
              </div>
            </div>
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
