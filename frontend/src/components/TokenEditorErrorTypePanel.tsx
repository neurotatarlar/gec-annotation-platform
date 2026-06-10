/**
 * Error type palette panel for assigning labels to selected corrections.
 */
import React, { useState } from "react";

import { ErrorType } from "../types";
import { getErrorTypeLabel, resolveErrorTypeColor } from "../utils/errorTypes";
import {
  categoryChipStyle,
  categoryColors,
  categoryPanelStyle,
  miniNeutralButton,
  rowLabelStyle,
} from "./TokenEditorStyles";

type ErrorTypePanelProps = {
  groupedErrorTypes: Array<{ label: string; items: ErrorType[] }>;
  errorTypesError: string | null;
  isLoadingErrorTypes: boolean;
  flashTypeId: number | null;
  locale: string;
  onTypePick: (typeId: number) => void;
  onOpenSettings: () => void;
  t: (key: string) => string;
};

export const TokenEditorErrorTypePanel: React.FC<ErrorTypePanelProps> = ({
  groupedErrorTypes,
  errorTypesError,
  isLoadingErrorTypes,
  flashTypeId,
  locale,
  onTypePick,
  onOpenSettings,
  t,
}) => {
  const [hoveredTypeId, setHoveredTypeId] = useState<number | null>(null);
  const [pressedTypeId, setPressedTypeId] = useState<number | null>(null);

  return (
    <div style={categoryPanelStyle}>
      <div style={{ ...rowLabelStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ visibility: "hidden" }}>{t("tokenEditor.categories")}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isLoadingErrorTypes && <span style={{ color: "#94a3b8" }}>{t("common.loading")}</span>}
          <button
            style={{
              ...miniNeutralButton,
              padding: "6px 8px",
              minWidth: 32,
              height: 32,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={onOpenSettings}
            title={t("common.settings")}
          >
            ⚙
          </button>
        </div>
      </div>
      {errorTypesError && <div style={{ color: "#fca5a5", fontSize: 12 }}>{errorTypesError}</div>}
      {!isLoadingErrorTypes && !errorTypesError && groupedErrorTypes.length === 0 && (
        <div style={{ color: "#94a3b8", fontSize: 12 }}>{t("annotation.noErrorTypesTitle")}</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {groupedErrorTypes.map((group, groupIdx) => (
          <div key={`${group.label}-${groupIdx}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {group.label && (
              <div style={{ color: "#cbd5e1", fontWeight: 700, fontSize: 13, textAlign: "left" }}>
                {group.label}
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {group.items.map((type, idx) => {
                const primary = getErrorTypeLabel(type, locale);
                const chipBg = resolveErrorTypeColor(
                  type.default_color,
                  categoryColors[(groupIdx + idx) % categoryColors.length]
                );
                const hotkey = (type.default_hotkey ?? "").trim();
                const isHover = hoveredTypeId === type.id;
                const isPressed = pressedTypeId === type.id;
                const isFlash = flashTypeId === type.id;
                const borderColor = isPressed
                  ? "rgba(226,232,240,0.9)"
                  : isFlash
                    ? "rgba(16,185,129,0.85)"
                    : isHover
                      ? "rgba(226,232,240,0.55)"
                      : "rgba(148,163,184,0.35)";
                return (
                  <div
                    key={type.id}
                    style={{
                      ...categoryChipStyle,
                      background: chipBg,
                      border: `${isFlash || isPressed ? 2 : 1}px solid ${borderColor}`,
                      boxShadow: isFlash
                        ? "0 0 0 2px rgba(16,185,129,0.25)"
                        : isHover
                          ? "0 0 0 1px rgba(226,232,240,0.2)"
                          : "none",
                      transform: isPressed ? "translateY(1px)" : "none",
                      transition: "transform 0.08s ease, box-shadow 0.2s ease, border-color 0.2s ease",
                      color: "rgba(248,250,252,0.85)",
                    }}
                    title={type.description ?? undefined}
                    role="button"
                    tabIndex={0}
                    onClick={() => onTypePick(type.id)}
                    onMouseEnter={() => setHoveredTypeId(type.id)}
                    onMouseLeave={() => {
                      setHoveredTypeId((prev) => (prev === type.id ? null : prev));
                      setPressedTypeId((prev) => (prev === type.id ? null : prev));
                    }}
                    onMouseDown={() => setPressedTypeId(type.id)}
                    onMouseUp={() => setPressedTypeId((prev) => (prev === type.id ? null : prev))}
                    onFocus={() => setHoveredTypeId(type.id)}
                    onBlur={() => {
                      setHoveredTypeId((prev) => (prev === type.id ? null : prev));
                      setPressedTypeId((prev) => (prev === type.id ? null : prev));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onTypePick(type.id);
                      }
                    }}
                  >
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <div style={{ fontWeight: 700 }}>{primary}</div>
                      {hotkey && (
                        <span
                          style={{
                            fontSize: 10,
                            color: "rgba(248,250,252,0.7)",
                            border: "1px solid rgba(248,250,252,0.25)",
                            borderRadius: 6,
                            padding: "2px 6px",
                            background: "rgba(15,23,42,0.2)",
                            lineHeight: 1.2,
                          }}
                        >
                          {hotkey}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
