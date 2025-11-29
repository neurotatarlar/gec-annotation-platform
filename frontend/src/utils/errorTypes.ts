import { Locale } from "../context/I18nContext";
import { ErrorType } from "../types";

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
