/**
 * Palette for selecting error types and displaying hotkeys/colors.
 */
import clsx from "clsx";

import { useI18n } from "../context/I18nContext";
import { ErrorType } from "../types";
import { getErrorTypeLabel, resolveErrorTypeColor } from "../utils/errorTypes";

interface Props {
  errorTypes: ErrorType[];
  activeId: number | null;
  onSelect: (id: number) => void;
}

export const ErrorTypePalette = ({ errorTypes, activeId, onSelect }: Props) => {
  const { locale } = useI18n();

  return (
    <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-800 bg-slate-900/80 p-3">
      {errorTypes.map((type) => {
        const chipBg = resolveErrorTypeColor(type.default_color);
        const label = getErrorTypeLabel(type, locale);
        return (
          <button
            key={type.id}
            className={clsx(
              "flex flex-col items-center rounded-xl border px-2.5 py-2 text-xs",
              activeId === type.id ? "border-emerald-400" : "border-transparent"
            )}
            style={{ backgroundColor: chipBg ?? undefined, color: "rgba(248,250,252,0.85)" }}
            onClick={() => onSelect(type.id)}
            title={type.description ?? undefined}
          >
            <span className="font-semibold">{label}</span>
            <span className="text-xs text-slate-100/70">{type.default_hotkey?.trim() || "-"}</span>
          </button>
        );
      })}
    </div>
  );
};
