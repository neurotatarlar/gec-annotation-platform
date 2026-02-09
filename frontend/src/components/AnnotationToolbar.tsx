/**
 * Toolbar for annotation actions such as save, skip, and trash.
 */
import { useI18n } from "../context/I18nContext";

interface Props {
  onSave: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
  stats?: string;
  saving?: boolean;
  submitting?: boolean;
}

export const AnnotationToolbar = ({ onSave, onSubmit, canSubmit, stats, saving, submitting }: Props) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-slate-800 bg-slate-900/80 p-4">
      <div>
        <p className="text-sm text-slate-400">{t("annotation.toolbarHint")}</p>
        {stats && <p className="text-xs text-slate-500">{stats}</p>}
      </div>
      <div className="flex gap-3">
        <button
          className="rounded-xl border border-slate-600 px-6 py-2 text-sm font-semibold disabled:opacity-50"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
        <button
          className="rounded-xl bg-emerald-500/80 px-6 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50"
          onClick={onSubmit}
          disabled={!canSubmit || submitting}
        >
          {t("common.submit")}
        </button>
      </div>
    </div>
  );
};
