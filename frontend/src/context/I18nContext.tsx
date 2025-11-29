import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import en from "../i18n/en.json";
import tt from "../i18n/tt.json";

type Messages = typeof en;

export type Locale = "en" | "tt";

const messageMap: Record<Locale, Messages> = { en, tt };

type TranslationParams = Record<string, string | number>;

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslationParams) => string;
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

const getMessage = (locale: Locale, key: string): string | undefined => {
  const parts = key.split(".");
  let current: any = messageMap[locale];
  for (const part of parts) {
    if (current && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
};

const interpolate = (template: string, params?: TranslationParams) => {
  if (!params) return template;
  return template.replace(/\{\{(.*?)\}\}/g, (_, token) => String(params[token.trim()] ?? ""));
};

export const I18nProvider = ({ children }: { children: React.ReactNode }) => {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof window === "undefined") return "tt";
    const stored = window.localStorage.getItem("locale");
    return (stored === "en" || stored === "tt") ? (stored as Locale) : "tt";
  });

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
      document.documentElement.dir = "ltr";
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem("locale", locale);
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
  }, []);

  const t = useCallback(
    (key: string, params?: TranslationParams) => {
      const template = getMessage(locale, key) ?? key;
      return interpolate(template, params);
    },
    [locale]
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = () => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
};
