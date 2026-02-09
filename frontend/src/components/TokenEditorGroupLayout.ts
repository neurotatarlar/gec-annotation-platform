/**
 * Computes layout metadata for token groups in the editor.
 */
import { Token } from "./TokenEditorModel";

type MeasureText = (text: string, size?: number) => number;
type GapMetricsFn = (
  prevTok: Token | null,
  nextTok: Token | undefined,
  isLineStart: boolean
) => { width: number; markerChar: string | null };

type GroupLayoutArgs = {
  tokens: Token[];
  historyTokens: Token[];
  tokenFontSize: number;
  badgeFontSize: number;
  badgeWidth: number;
  isMoveGroup: boolean;
  isMoveDestination: boolean;
  isMoveSource: boolean;
  isPurePunctGroup: boolean;
  hasHistory: boolean;
  hasType: boolean;
  groupPadX: number;
  measureTextWidth: MeasureText;
  getGapMetrics: GapMetricsFn;
};

export const getTokenDisplayText = (tok: Token) => {
  if (tok.kind === "empty") return "⬚";
  if (tok.kind === "special" && tok.text.length > 32) {
    return `${tok.text.slice(0, 18)}…${tok.text.slice(-10)}`;
  }
  return tok.text;
};

export const computeGroupLayout = ({
  tokens,
  historyTokens,
  tokenFontSize,
  badgeFontSize,
  badgeWidth,
  isMoveGroup,
  isMoveDestination,
  isMoveSource,
  isPurePunctGroup,
  hasHistory,
  hasType,
  groupPadX,
  measureTextWidth,
  getGapMetrics,
}: GroupLayoutArgs) => {
  const correctedWidth = tokens.reduce((acc, tok, i) => {
    const display = getTokenDisplayText(tok);
    const tokenWidth =
      tok.kind === "empty"
        ? tok.moveId
          ? Math.max(2, Math.round(tokenFontSize * 0.12))
          : tok.previousTokens?.length
            ? Math.max(
                measureTextWidth("⬚", Math.max(8, Math.round(tokenFontSize * 0.75))),
                tokenFontSize * 0.45
              )
            : Math.max(2, Math.round(tokenFontSize * 0.12))
        : Math.max(measureTextWidth(display), tokenFontSize * 0.6);
    const gapWidth = i === 0 ? 0 : getGapMetrics(tokens[i - 1], tok, false).width;
    return acc + tokenWidth + gapWidth;
  }, 0);

  const historyWidth = historyTokens.reduce((acc, prev, i) => {
    const width = Math.max(measureTextWidth(prev.text, badgeFontSize), badgeFontSize * 0.8);
    return acc + width + (i ? 6 : 0);
  }, 0);

  const baseContentWidth =
    isMoveGroup && !isMoveDestination
      ? correctedWidth
      : Math.max(correctedWidth, historyWidth, badgeWidth);

  const minWidth = isMoveSource
    ? Math.max(correctedWidth + groupPadX * 2, tokenFontSize * 0.6)
    : isPurePunctGroup && !hasHistory && !hasType
      ? Math.max(badgeWidth, baseContentWidth, tokenFontSize * 0.7 * tokens.length) + groupPadX * 2
      : Math.max(24 + groupPadX * 2, baseContentWidth + groupPadX * 2);

  return { correctedWidth, historyWidth, baseContentWidth, minWidth };
};
