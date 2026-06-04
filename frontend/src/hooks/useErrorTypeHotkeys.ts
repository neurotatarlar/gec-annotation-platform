/**
 * Hook for applying error types via configured keyboard shortcuts.
 */
import { useEffect, useMemo } from "react";

import { ErrorType } from "../types";
import { buildHotkeyMap, HotkeySpec, normalizeHotkeySpec } from "../components/TokenEditorModel";

export const eventToHotkeyStrings = (
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
): { keySpec: string | null; codeSpec: string | null } => {
  const key = event.key?.toLowerCase();
  if (!key) return { keySpec: null, codeSpec: null };
  if (["shift", "control", "ctrl", "alt", "meta"].includes(key)) {
    return { keySpec: null, codeSpec: null };
  }
  const baseSpec: HotkeySpec = {
    key,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
  const keySpec = normalizeHotkeySpec(baseSpec);
  const codeSpec = event.code ? normalizeHotkeySpec({ ...baseSpec, code: event.code }, true) : null;
  return { keySpec, codeSpec };
};

const isEditableTarget = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return Boolean(
    el &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
};

export const useErrorTypeHotkeys = (
  errorTypes: ErrorType[],
  onTypePick: (typeId: number) => void
) => {
  const hotkeyMap = useMemo(() => buildHotkeyMap(errorTypes), [errorTypes]);

  useEffect(() => {
    if (Object.keys(hotkeyMap).length === 0) return;
    const handler = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const { keySpec, codeSpec } = eventToHotkeyStrings(event);
      if (!keySpec && !codeSpec) return;
      const typeId = (keySpec && hotkeyMap[keySpec]) || (codeSpec && hotkeyMap[codeSpec]);
      if (!typeId) return;
      event.preventDefault();
      onTypePick(typeId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hotkeyMap, onTypePick]);

  return { hotkeyMap };
};
