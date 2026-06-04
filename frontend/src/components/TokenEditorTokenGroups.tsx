/**
 * Renders token groups, spacing gaps, line breaks, move placeholders, and correction badges.
 */
import React from "react";

import { ErrorType } from "../types";
import { getErrorTypeLabel, resolveErrorTypeColor } from "../utils/errorTypes";
import { TokenGap } from "./TokenEditorGap";
import { TokenEditorGroup } from "./TokenEditorGroup";
import { buildTokenGroups } from "./TokenEditorGrouping";
import { MoveMarker, Token } from "./TokenEditorModel";
import { createGapCalculator, SpaceMarker } from "./TokenEditorSpacing";
import { chipStyles } from "./TokenEditorStyles";

type TokenEditorTokenGroupsProps = {
  tokens: Token[];
  tokenGap: number;
  tokenFontSize: number;
  spaceMarker: SpaceMarker;
  isEditing: boolean;
  lineStartIndices: Set<number>;
  lineBreakCountMap: Map<number, number>;
  dropIndex: number | null;
  moveIndexToId: Map<number, string>;
  moveMarkerById: Map<string, MoveMarker>;
  hoveredMoveId: string | null;
  correctionByIndex: Map<number, string>;
  correctionTypeMap: Record<string, number | null>;
  errorTypeById: Map<number, ErrorType>;
  locale: string;
  t: (key: string) => string;
  measureTextWidth: (text: string, size?: number) => number;
  renderToken: (token: Token, index: number, forceChanged?: boolean) => React.ReactNode;
  onHandleDragOverGap: (index: number, event: React.DragEvent<HTMLDivElement>) => void;
  onHandleDropAt: (index: number) => void;
  onHandleRevert: (start: number, end: number) => void;
  onRevertMove: (moveId: string) => void;
  onSelectRange: (range: { start: number; end: number }) => void;
  onMoveEnter: (moveId: string) => void;
  onMoveLeave: (moveId: string) => void;
  setGroupRef: (groupKey: string, el: HTMLDivElement | null) => void;
};

export const TokenEditorTokenGroups: React.FC<TokenEditorTokenGroupsProps> = ({
  tokens,
  tokenGap,
  tokenFontSize,
  spaceMarker,
  isEditing,
  lineStartIndices,
  lineBreakCountMap,
  dropIndex,
  moveIndexToId,
  moveMarkerById,
  hoveredMoveId,
  correctionByIndex,
  correctionTypeMap,
  errorTypeById,
  locale,
  t,
  measureTextWidth,
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
  const { getGapMetrics, markerStyle } = createGapCalculator({
    tokenGap,
    tokenFontSize,
    spaceMarker,
    isEditing,
  });
  const groups = buildTokenGroups(tokens);
  let visibleCount = 0;

  const renderGap = (idx: number) => {
    const nextTok = tokens[idx];
    const prevTok = idx > 0 ? tokens[idx - 1] : null;
    const isLineStart = lineStartIndices.has(idx);
    const { width: gapWidth, markerChar } = getGapMetrics(prevTok, nextTok, isLineStart);
    return (
      <TokenGap
        key={`gap-${idx}`}
        index={idx}
        width={gapWidth}
        height={Math.max(28, tokenFontSize * 1.2)}
        markerChar={markerChar}
        markerStyle={markerStyle}
        isActive={dropIndex === idx}
        onDragOver={(event) => onHandleDragOverGap(idx, event)}
        onDrop={() => onHandleDropAt(idx)}
      />
    );
  };

  const result: React.ReactNode[] = [renderGap(0)];

  groups.forEach((group, groupIndex) => {
    const hasHistory = group.tokens.some((token) => token.previousTokens?.length);
    const anchorToken =
      group.tokens.find((token) => token.previousTokens?.length) ??
      group.tokens[Math.floor(group.tokens.length / 2)];
    const historyTokens = anchorToken.previousTokens ?? [];
    const moveId = moveIndexToId.get(group.start) ?? moveIndexToId.get(group.end);
    const moveMarker = moveId ? moveMarkerById.get(moveId) ?? null : null;
    const isMoveGroup = Boolean(moveId);
    const isMoveDestination = Boolean(
      moveMarker && group.start >= moveMarker.toStart && group.end <= moveMarker.toEnd
    );
    const cardId = moveId ?? correctionByIndex.get(group.start) ?? correctionByIndex.get(group.end);
    const typeId = cardId ? correctionTypeMap[cardId] ?? null : null;
    const resolvedType = typeId ? errorTypeById.get(typeId) ?? null : null;
    const typeObj = isMoveGroup && !isMoveDestination ? null : resolvedType;
    const badgeText = typeObj ? getErrorTypeLabel(typeObj, locale) : "";
    const badgeColor = resolveErrorTypeColor(typeObj?.default_color);
    const badgeFontSize = Math.max(8, tokenFontSize * 0.45);
    const badgePaddingY = Math.max(0.5, tokenFontSize * 0.07);
    const badgePaddingX = Math.max(2, tokenFontSize * 0.18);
    const badgeRadius = Math.max(6, tokenFontSize * 0.45);
    const isPurePunctGroup = group.tokens.every((token) => token.kind === "punct");

    group.tokens.forEach((token) => {
      if (token.kind !== "empty") visibleCount += 1;
    });

    const showBorder = hasHistory || isMoveGroup;
    const showHistoryTokens = hasHistory && !isMoveGroup;
    const showUndo = (hasHistory && !isMoveGroup) || (isMoveDestination && moveId);
    const isMoveHover = Boolean(moveId && hoveredMoveId === moveId);
    const isMoveSource = isMoveGroup && !isMoveDestination;
    const groupPadX = isMoveSource ? 0 : isPurePunctGroup ? 0 : 1;
    const movePlaceholderHeight = Math.max(14, Math.round(tokenFontSize * 1.1));
    const groupKey = `range:${group.start}-${group.end}`;
    const isPlainGroup = !hasHistory && !isMoveGroup && !typeObj;

    if (isPlainGroup && group.tokens.length === 1) {
      result.push(renderToken(group.tokens[0], group.start));
      const lineBreakHeight = Math.max(4, Math.round(tokenFontSize * 0.45));
      const breakCount = lineBreakCountMap.get(visibleCount) ?? 0;
      if (breakCount > 0) {
        for (let i = 0; i < breakCount; i += 1) {
          result.push(
            <div
              key={`br-${visibleCount}-${i}`}
              data-testid="line-break"
              style={{
                width: "100%",
                height: lineBreakHeight,
              }}
            />
          );
        }
      }
      result.push(renderGap(group.end + 1));
      return;
    }

    result.push(
      <TokenEditorGroup
        key={groupKey}
        group={group}
        groupIndex={groupIndex}
        tokenFontSize={tokenFontSize}
        t={t}
        historyTokens={historyTokens}
        hasHistory={hasHistory}
        moveId={moveId ?? null}
        isMoveGroup={isMoveGroup}
        isMoveDestination={isMoveDestination}
        isMoveSource={isMoveSource}
        isMoveHover={isMoveHover}
        showBorder={showBorder}
        showHistoryTokens={showHistoryTokens}
        showUndo={showUndo}
        isPurePunctGroup={isPurePunctGroup}
        typeObj={typeObj}
        badgeText={badgeText}
        badgeColor={badgeColor}
        badgeFontSize={badgeFontSize}
        badgePaddingY={badgePaddingY}
        badgePaddingX={badgePaddingX}
        badgeRadius={badgeRadius}
        groupPadX={groupPadX}
        movePlaceholderHeight={movePlaceholderHeight}
        dropIndex={dropIndex}
        markerStyle={markerStyle}
        previousTokenStyle={chipStyles.previous}
        previousTokenFontStyle={chipStyles.previous.fontStyle as string | undefined}
        measureTextWidth={measureTextWidth}
        getGapMetrics={getGapMetrics}
        renderToken={renderToken}
        onHandleDragOverGap={onHandleDragOverGap}
        onHandleDropAt={onHandleDropAt}
        onHandleRevert={onHandleRevert}
        onRevertMove={onRevertMove}
        onSelectRange={onSelectRange}
        onMoveEnter={onMoveEnter}
        onMoveLeave={onMoveLeave}
        setGroupRef={(el) => setGroupRef(groupKey, el)}
      />
    );

    const lineBreakHeight = Math.max(4, Math.round(tokenFontSize * 0.45));
    const breakCount = lineBreakCountMap.get(visibleCount) ?? 0;
    if (breakCount > 0) {
      for (let i = 0; i < breakCount; i += 1) {
        result.push(
          <div
            key={`br-${visibleCount}-${i}`}
            data-testid="line-break"
            style={{
              width: "100%",
              height: lineBreakHeight,
              flexBasis: "100%",
              flexShrink: 0,
              flexGrow: 0,
            }}
          />
        );
      }
    }
    result.push(renderGap(group.end + 1));
  });

  return <>{result}</>;
};
