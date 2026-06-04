/**
 * Hook for token editor UI preferences stored in localStorage.
 */
import { useEffect, useMemo, useState } from "react";

import {
  loadPrefs,
  normalizeSpaceMarker,
  persistPrefs,
} from "../components/TokenEditorStorage";
import { SpaceMarker } from "../components/TokenEditorSpacing";

export const MIN_TOKEN_GAP = 0;
export const MAX_TOKEN_GAP = 40;
export const DEFAULT_TOKEN_GAP = Math.round((MIN_TOKEN_GAP + MAX_TOKEN_GAP) / 2);
export const DEFAULT_TOKEN_FONT_SIZE = 24;

const normalizeViewTab = (value: unknown): "original" | "corrected" =>
  value === "original" || value === "corrected" ? value : "corrected";

export const useTokenEditorPrefs = (textId: number) => {
  const prefs = useMemo(() => loadPrefs(), []);
  const [tokenGap, setTokenGap] = useState(
    Math.max(MIN_TOKEN_GAP, prefs.tokenGap ?? DEFAULT_TOKEN_GAP)
  );
  const [tokenFontSize, setTokenFontSize] = useState(
    prefs.tokenFontSize ?? DEFAULT_TOKEN_FONT_SIZE
  );
  const [spaceMarker, setSpaceMarker] = useState<SpaceMarker>(
    normalizeSpaceMarker(prefs.spaceMarker)
  );
  const [viewTab, setViewTab] = useState<"original" | "corrected">(
    normalizeViewTab(prefs.viewTab)
  );
  const [isTextPanelOpen, setIsTextPanelOpen] = useState<boolean>(
    prefs.textPanelOpen ?? true
  );
  const [lastDecision, setLastDecision] = useState<"skip" | "trash" | "submit" | null>(
    prefs.lastTextId === textId ? prefs.lastDecision ?? null : null
  );

  useEffect(() => {
    persistPrefs({
      tokenGap,
      tokenFontSize,
      spaceMarker,
      lastDecision,
      lastTextId: textId,
      viewTab,
      textPanelOpen: isTextPanelOpen,
    });
  }, [tokenGap, tokenFontSize, spaceMarker, lastDecision, textId, viewTab, isTextPanelOpen]);

  return {
    tokenGap,
    setTokenGap,
    tokenFontSize,
    setTokenFontSize,
    spaceMarker,
    setSpaceMarker,
    viewTab,
    setViewTab,
    isTextPanelOpen,
    setIsTextPanelOpen,
    lastDecision,
    setLastDecision,
  };
};
