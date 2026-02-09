/**
 * Whitespace and spacing helpers for token rendering.
 */
import type { CSSProperties } from "react";

import { Token } from "./TokenEditorModel";

export type SpaceMarker = "dot" | "box" | "none";

type GapMetrics = { width: number; markerChar: string | null };

type GapConfig = {
  tokenGap: number;
  tokenFontSize: number;
  spaceMarker: SpaceMarker;
  isEditing: boolean;
};

export const createGapCalculator = ({ tokenGap, tokenFontSize, spaceMarker, isEditing }: GapConfig) => {
  const baseGap = Math.max(0, tokenGap);
  const minSpaceWidth = Math.max(2, tokenFontSize * 0.16);
  const normalGap = Math.max(baseGap, minSpaceWidth);
  const compactGap = Math.max(1, normalGap * 0.25);
  const punctGap = Math.max(1, normalGap * 0.1);
  const spaceMarkerToUse: SpaceMarker = isEditing ? "none" : spaceMarker;

  const resolveExplicitSpace = (tok: Token | undefined, isLineStart: boolean) => {
    if (!tok || isLineStart) return false;
    if (tok.spaceBefore === true) return true;
    if (tok.spaceBefore === false) return false;
    return tok.kind !== "punct";
  };

  const getGapMetrics = (prevTok: Token | null, nextTok: Token | undefined, isLineStart: boolean): GapMetrics => {
    if (!nextTok || isLineStart) {
      return { width: 0, markerChar: null };
    }
    const explicitSpace = resolveExplicitSpace(nextTok, false);
    const isPunctAdjacent = nextTok.kind === "punct" || prevTok?.kind === "punct";
    const width = explicitSpace ? normalGap : isPunctAdjacent ? punctGap : compactGap;
    const markerChar: string | null =
      explicitSpace && spaceMarkerToUse !== "none" && !isEditing
        ? spaceMarkerToUse === "dot"
          ? "·"
          : spaceMarkerToUse === "box"
            ? "␣"
            : null
        : null;
    return { width, markerChar };
  };

  const markerShift = Math.max(0, tokenFontSize * 0.08);
  const markerStyle: CSSProperties = {
    fontSize: Math.max(8, tokenFontSize * 0.45),
    color: "rgba(148,163,184,0.6)",
    lineHeight: 1,
    pointerEvents: "none",
    userSelect: "none",
    position: "absolute",
    top: "50%",
    transform: `translateY(calc(-50% + ${markerShift}px))`,
  };

  return { getGapMetrics, markerStyle };
};
