/**
 * Helpers for sorting, grouping, and formatting error types.
 */
import { Locale } from "../context/I18nContext";
import { ErrorType } from "../types";

export type ErrorTypeGroup = { label: string; items: ErrorType[] };

export const sortActiveErrorTypes = (errorTypes: ErrorType[]) =>
  errorTypes
    .filter((type) => type.is_active)
    .slice()
    .sort((a, b) => {
      const aCategory = (a.category_en ?? "").toLowerCase();
      const bCategory = (b.category_en ?? "").toLowerCase();
      if (aCategory !== bCategory) {
        return aCategory.localeCompare(bCategory);
      }
      const aOrder = a.sort_order ?? 0;
      const bOrder = b.sort_order ?? 0;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      const aName = (a.en_name ?? "").toLowerCase();
      const bName = (b.en_name ?? "").toLowerCase();
      if (aName !== bName) {
        return aName.localeCompare(bName);
      }
      return a.id - b.id;
    });

export const groupErrorTypes = (
  errorTypes: ErrorType[],
  locale: Locale,
  fallbackLabel: string
): ErrorTypeGroup[] => {
  const groups = new Map<string, ErrorTypeGroup>();
  errorTypes.forEach((type) => {
    const label = getErrorTypeSuperLabel(type, locale) || type.category_en || fallbackLabel;
    const key = label || type.id.toString();
    const bucket = groups.get(key) ?? { label, items: [] };
    bucket.items.push(type);
    groups.set(key, bucket);
  });
  return Array.from(groups.values());
};

export const getErrorTypeLabel = (type: ErrorType, locale: Locale) => {
  const localized = locale === "tt" ? type.tt_name : type.en_name;
  const fallback = locale === "tt" ? type.en_name : type.tt_name;
  return (localized ?? fallback ?? "").trim();
};

export const getErrorTypeSecondaryLabel = (type: ErrorType, locale: Locale) => {
  if (locale === "tt") {
    return (type.en_name ?? "")?.trim() ?? "";
  }
  return (type.tt_name ?? "").trim();
};

export const getErrorTypeSuperLabel = (type: ErrorType, locale: Locale) => {
  const localized = locale === "tt" ? type.category_tt : type.category_en;
  return localized?.trim() ?? "";
};

export const colorWithAlpha = (color: string | null | undefined, alpha: number) => {
  const normalized = color?.trim();
  if (!normalized || !normalized.startsWith("#")) return null;
  const hex = normalized.slice(1);
  if (![3, 6, 8].includes(hex.length)) return null;

  const to255 = (value: string) => parseInt(value, 16);
  const safeAlpha = Math.max(0, Math.min(alpha, 1));

  let r: number;
  let g: number;
  let b: number;
  if (hex.length === 3) {
    r = to255(hex[0] + hex[0]);
    g = to255(hex[1] + hex[1]);
    b = to255(hex[2] + hex[2]);
  } else {
    r = to255(hex.slice(0, 2));
    g = to255(hex.slice(2, 4));
    b = to255(hex.slice(4, 6));
  }

  return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
};

export const resolveErrorTypeColor = (
  color: string | null | undefined,
  fallback = "#94a3b8"
) => {
  const normalized = color?.trim();
  if (!normalized) return fallback;
  const valid = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(normalized);
  return valid ? normalized : fallback;
};
