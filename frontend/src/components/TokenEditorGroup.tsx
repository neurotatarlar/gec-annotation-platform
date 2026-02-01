import React from "react";

import { ErrorType } from "../types";
import { TokenGap } from "./TokenEditorGap";
import { computeGroupLayout } from "./TokenEditorGroupLayout";
import { Token } from "./TokenEditorModel";

type GapMetricsFn = (
  prevTok: Token | null,
  nextTok: Token | undefined,
  isLineStart: boolean
) => { width: number; markerChar: string | null };

type TokenGroup = {
  tokens: Token[];
  start: number;
  end: number;
};

type TokenEditorGroupProps = {
  group: TokenGroup;
  groupIndex: number;
  tokenFontSize: number;
  t: (key: string) => string;
  historyTokens: Token[];
  hasHistory: boolean;
  moveId: string | null;
  isMoveGroup: boolean;
  isMoveDestination: boolean;
  isMoveSource: boolean;
  isMoveHover: boolean;
  showBorder: boolean;
  showHistoryTokens: boolean;
  showUndo: boolean;
  isPurePunctGroup: boolean;
  typeObj: ErrorType | null;
  badgeText: string;
  badgeColor: string;
  badgeFontSize: number;
  badgePaddingY: number;
  badgePaddingX: number;
  badgeRadius: number;
  groupPadX: number;
  movePlaceholderHeight: number;
  dropIndex: number | null;
  markerStyle: React.CSSProperties;
  previousTokenStyle: React.CSSProperties;
  previousTokenFontStyle: string | undefined;
  measureTextWidth: (text: string, size?: number) => number;
  getGapMetrics: GapMetricsFn;
  renderToken: (token: Token, index: number, forceChanged?: boolean) => React.ReactNode;
  onHandleDragOverGap: (index: number, event: React.DragEvent<HTMLDivElement>) => void;
  onHandleDropAt: (index: number) => void;
  onHandleRevert: (start: number, end: number) => void;
  onRevertMove: (moveId: string) => void;
  onSelectRange: (range: { start: number; end: number }) => void;
  onMoveEnter: (moveId: string) => void;
  onMoveLeave: (moveId: string) => void;
  setGroupRef: (el: HTMLDivElement | null) => void;
};

const groupUndoButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: -10,
  right: -10,
  width: 20,
  height: 20,
  borderRadius: "50%",
  border: "1px solid rgba(148,163,184,0.5)",
  background: "rgba(15,23,42,0.8)",
  color: "#e2e8f0",
  fontSize: 12,
  cursor: "pointer",
  zIndex: 2,
  pointerEvents: "auto",
};

export const TokenEditorGroup: React.FC<TokenEditorGroupProps> = ({
  group,
  groupIndex,
  tokenFontSize,
  t,
  historyTokens,
  hasHistory,
  moveId,
  isMoveGroup,
  isMoveDestination,
  isMoveSource,
  isMoveHover,
  showBorder,
  showHistoryTokens,
  showUndo,
  isPurePunctGroup,
  typeObj,
  badgeText,
  badgeColor,
  badgeFontSize,
  badgePaddingY,
  badgePaddingX,
  badgeRadius,
  groupPadX,
  movePlaceholderHeight,
  dropIndex,
  markerStyle,
  previousTokenStyle,
  previousTokenFontStyle,
  measureTextWidth,
  getGapMetrics,
  renderToken,
  onHandleDragOverGap,
  onHandleDropAt,
  onHandleRevert,
  onRevertMove,
  onSelectRange,
  onMoveEnter,
  onMoveLeave,
  setGroupRef,
}) => {
  const badgeTextWidth = badgeText ? measureTextWidth(badgeText, badgeFontSize) : 0;
  const badgeWidth = badgeText ? badgeTextWidth + badgePaddingX * 2 + 10 : 0;
  const { minWidth } = computeGroupLayout({
    tokens: group.tokens,
    historyTokens,
    tokenFontSize,
    badgeFontSize,
    badgeWidth,
    isMoveGroup,
    isMoveDestination,
    isMoveSource,
    isPurePunctGroup,
    hasHistory,
    hasType: Boolean(typeObj),
    groupPadX,
    measureTextWidth,
    getGapMetrics,
  });
  const groupPadY = 0;
  const paddingTop = groupPadY;
  const verticalGap = Math.max(0, tokenFontSize * (isMoveSource ? 0 : 0.02));
  const groupRadius = isMoveSource ? 10 : 14;
  const groupShadow = showBorder
    ? isMoveSource
      ? isMoveHover
        ? "0 0 0 1px rgba(94,234,212,0.5)"
        : "none"
      : isMoveHover
        ? "0 0 0 1px rgba(94,234,212,0.5)"
        : "0 0 0 1px rgba(148,163,184,0.25)"
    : "none";

  return (
    <div
      key={`group-${groupIndex}-${group.tokens[0].id}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: verticalGap,
        padding: `${paddingTop}px ${groupPadX}px ${groupPadY}px ${groupPadX}px`,
        borderRadius: groupRadius,
        border: showBorder
          ? isMoveHover
            ? "1px solid rgba(94,234,212,0.85)"
            : isMoveSource
              ? "1px solid transparent"
              : "1px solid rgba(148,163,184,0.35)"
          : "1px solid transparent",
        background: "transparent",
        boxShadow: groupShadow,
        flex: "0 0 auto",
        minWidth,
        height: isMoveSource ? movePlaceholderHeight : undefined,
        minHeight: isMoveSource ? movePlaceholderHeight : undefined,
        alignSelf: isMoveDestination ? "flex-start" : undefined,
        position: "relative",
      }}
      data-group-start={group.start}
      data-group-end={group.end}
      data-group-move={moveId ?? undefined}
      ref={setGroupRef}
      onClick={() => {
        if (!showBorder) return;
        onSelectRange({ start: group.start, end: group.end });
      }}
      onMouseEnter={() => {
        if (moveId) onMoveEnter(moveId);
      }}
      onMouseLeave={() => {
        if (moveId) onMoveLeave(moveId);
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 0,
          flexWrap: "wrap",
          justifyContent: "flex-start",
          alignItems: "flex-start",
          alignContent: "flex-start",
          lineHeight: 1.05,
          marginBottom: isMoveSource ? 0 : Math.max(0, tokenFontSize * 0.03),
        }}
      >
        {showUndo && (
          <button
            style={groupUndoButtonStyle}
            onClick={(event) => {
              event.stopPropagation();
              if (isMoveDestination && moveId) {
                onRevertMove(moveId);
              } else {
                onHandleRevert(group.start, group.end);
              }
            }}
            title={t("tokenEditor.undo")}
          >
            ↺
          </button>
        )}
        {group.tokens.map((tok, i) => {
          const nodes: React.ReactNode[] = [];
          if (i > 0) {
                const { width: gapWidth, markerChar } = getGapMetrics(group.tokens[i - 1], tok, false);
                nodes.push(
                  <TokenGap
                    key={`inner-gap-${group.start + i}`}
                    index={group.start + i}
                    width={gapWidth}
                    height={Math.max(28, tokenFontSize * 1.2)}
                    markerChar={markerChar}
                    markerStyle={markerStyle}
                    isActive={dropIndex === group.start + i}
                    onDragOver={(event) => onHandleDragOverGap(group.start + i, event)}
                    onDrop={() => onHandleDropAt(group.start + i)}
                  />
                );
              }
          const forceChanged = (isMoveDestination || hasHistory) && tok.kind !== "empty";
          nodes.push(renderToken(tok, group.start + i, forceChanged));
          return nodes;
        })}
      </div>
      {showHistoryTokens && historyTokens.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            justifyContent: "center",
            textAlign: "center",
            marginBottom: 0,
          }}
        >
          {historyTokens.map((prev) => (
            <span
              key={`${groupIndex}-prev-${prev.id}`}
              style={{
                ...previousTokenStyle,
                fontSize: Math.max(8, tokenFontSize * 0.6),
                fontStyle: prev.kind === "empty" || prev.text === "⬚" ? "normal" : previousTokenFontStyle,
                padding: `${Math.max(0, tokenFontSize * 0.08)}px ${Math.max(1, tokenFontSize * 0.2)}px`,
              }}
            >
              {prev.text}
            </span>
          ))}
        </div>
      )}
      {typeObj && (
        <div
          style={{
            padding: `${badgePaddingY}px ${badgePaddingX}px`,
            borderRadius: badgeRadius,
            background: badgeColor,
            border: "1px solid rgba(0,0,0,0.25)",
            boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
            color: "rgba(248,250,252,0.85)",
            fontSize: badgeFontSize,
            fontWeight: 600,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            alignSelf: "center",
            marginTop: 0,
          }}
          title={badgeText}
          data-badge-text={badgeText}
        >
          {badgeText}
        </div>
      )}
    </div>
  );
};
