import clsx from "clsx";
import { useEffect, useState } from "react";

import { useI18n } from "../context/I18nContext";
import { AnnotationDraft, ErrorType } from "../types";
import { getErrorTypeLabel } from "../utils/errorTypes";

interface AnnotationSidebarProps {
  annotations: AnnotationDraft[];
  errorTypes: ErrorType[];
  baseTokens: string[];
  activeIndex: number | null;
  onSelect: (index: number) => void;
  onRemove: (index: number) => void;
  onClearAll?: () => void;
}

export const AnnotationSidebar = ({
  annotations,
  errorTypes,
  baseTokens,
  activeIndex,
  onSelect,
  onRemove,
  onClearAll
}: AnnotationSidebarProps) => {
  const { t, locale } = useI18n();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    const raw = window.localStorage.getItem("annotationSidebarCollapsed");
    return raw === "true";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("annotationSidebarCollapsed", String(collapsed));
  }, [collapsed]);

  const groupByLink = (items: AnnotationDraft[]) => {
    const buckets = new Map<string, AnnotationDraft[]>();
    const singles: AnnotationDraft[] = [];
    items.forEach((ann) => {
      const linkId = typeof ann.payload?.linkId === "string" ? (ann.payload.linkId as string) : null;
      if (linkId) {
        const list = buckets.get(linkId) ?? [];
        list.push(ann);
        buckets.set(linkId, list);
      } else {
        singles.push(ann);
      }
    });
    const grouped: { annotations: AnnotationDraft[]; linkId?: string }[] = [];
    singles.forEach((ann) => grouped.push({ annotations: [ann] }));
    buckets.forEach((value, key) => grouped.push({ annotations: value, linkId: key }));
    return grouped;
  };

  const getOriginalText = (annotation: AnnotationDraft) => {
    const variant = (annotation.payload?.variant as string) ?? "replace";
    if (variant === "insert_before" || variant === "insert_after") {
      return "<EMPTY>";
    }
    if (!baseTokens.length) {
      return "";
    }
    const start = Math.max(0, Math.min(annotation.start_token, baseTokens.length - 1));
    const end = Math.max(0, Math.min(annotation.end_token, baseTokens.length - 1));
    return baseTokens.slice(start, end + 1).join(" ");
  };

  const getReplacementText = (annotations: AnnotationDraft[]) => {
    if (annotations.length === 2) {
      const insertion = annotations.find((ann) => {
        const variant = (ann.payload?.variant as string) ?? "replace";
        return variant === "insert_before" || variant === "insert_after";
      });
      if (insertion) {
        const text = insertion.replacement ?? "";
        return text.trim().length > 0 ? text : "<EMPTY>";
      }
    }
    const annotation = annotations[0];
    const replacement = annotation.replacement ?? "";
    if (replacement.trim().length === 0) {
      return "<EMPTY>";
    }
    return replacement;
  };
  const describe = (annotations: AnnotationDraft[]) => {
    const main = annotations[0];
    const errorType = errorTypes.find((type) => type.id === main.error_type_id);
    const label = errorType ? getErrorTypeLabel(errorType, locale) : t("sidebar.unknown");
    return `${label} (${main.start_token + 1}-${main.end_token + 1})`;
  };

  return (
    <aside
      className={clsx(
        "flex w-full flex-col rounded-3xl border border-slate-800 bg-slate-900/80 transition-all",
        collapsed ? "gap-2 p-3 xl:w-[3.5rem]" : "gap-4 p-4 xl:w-96"
      )}
    >
      <header className="flex items-center justify-between gap-2">
        {!collapsed && (
          <div className="text-left">
            <h3 className="text-lg font-semibold">{t("sidebar.title")}</h3>
            <span className="text-sm text-slate-400">{t("sidebar.count", { count: annotations.length })}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          {!collapsed && (
            <button
              className="rounded-lg border border-rose-400/60 px-2 py-1 text-xs text-rose-200 disabled:opacity-40"
              disabled={!annotations.length}
              onClick={onClearAll}
            >
              {t("sidebar.clear")}
            </button>
          )}
          <button
            className="rounded-lg border border-slate-600 px-2 py-1 text-sm text-slate-100"
            onClick={() => setCollapsed((prev) => !prev)}
            aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>
      </header>
      {!collapsed && (
        <div className="space-y-3">
          {groupByLink(annotations).map(({ annotations: group }, index) => {
            const primary = group[0];
            return (
              <div
                key={`${primary.start_token}-${index}`}
                className={clsx(
                  "rounded-2xl border border-slate-700/60 p-3 text-sm",
                  activeIndex === index && "border-emerald-400"
                )}
              >
                <button className="w-full text-right font-semibold" onClick={() => onSelect(index)}>
                  {describe(group)}
                </button>
                <div className="mt-2 space-y-1 text-xs">
                  <p className="text-slate-400">
                    {t("sidebar.old")}:{" "}
                    <span className="font-mono text-rose-200">{getOriginalText(primary)}</span>
                  </p>
                  <p className="text-slate-400">
                    {t("sidebar.new")}:{" "}
                    <span className="font-mono text-emerald-200">{getReplacementText(group)}</span>
                  </p>
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  {primary.replacement !== "<EMPTY>" && (
                    <button
                      className="rounded-lg border border-slate-600 px-3 py-1 text-xs"
                      onClick={() => onSelect(index)}
                    >
                      {t("sidebar.edit")}
                    </button>
                  )}
                  <button
                    className="rounded-lg border border-rose-500/70 px-3 py-1 text-xs text-rose-300"
                    onClick={() => onRemove(index)}
                  >
                    {t("sidebar.remove")}
                  </button>
                </div>
              </div>
            );
          })}
          {annotations.length === 0 && <p className="text-sm text-slate-500">{t("sidebar.empty")}</p>}
        </div>
      )}
    </aside>
  );
};
