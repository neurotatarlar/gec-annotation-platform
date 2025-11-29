import { Locale, useI18n } from "../context/I18nContext";

export const LanguageSwitcher = () => {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      className="rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100"
      value={locale}
      onChange={(event) => setLocale(event.target.value as Locale)}
    >
      <option value="tt">{t("language.tt")}</option>
      <option value="en">{t("language.en")}</option>
    </select>
  );
};
