/**
 * Renders a single token chip or the active inline edit pill.
 */
import React from "react";

import {
  estimateCaretIndexFromClick,
  expandEditRangeToTokenGroup,
} from "../hooks/useTokenSelectionHandlers";
import { Token, buildEditableTextFromTokens } from "./TokenEditorModel";
import { chipBase, chipStyles } from "./TokenEditorStyles";

type SelectionRange = { start: number | null; end: number | null };

type Props = {
  token: Token;
  index: number;
  forceChanged?: boolean;
  isSelected: boolean;
  editingRange: SelectionRange | null;
  tokens: Token[];
  tokenFontSize: number;
  editText: string;
  editInputRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  suppressBlurCommitRef: React.MutableRefObject<boolean>;
  t: (key: string) => string;
  measureTextWidth: (text: string, size?: number) => number;
  updateEditText: (value: string) => void;
  commitEdit: () => void;
  cancelEdit: () => void;
  setSelection: (range: SelectionRange) => void;
  beginEdit: (range?: { start: number; end: number }, caretIndex?: number) => void;
  handleDragStart: (index: number, event: React.DragEvent<HTMLElement>) => void;
  handleDragOverToken: (index: number, event: React.DragEvent<HTMLElement>) => void;
  handleDropAt: (index: number) => void;
  handleDragEnd: () => void;
  handleTokenClick: (index: number, ctrlKey: boolean) => void;
  setTokenRef: (tokenId: string, el: HTMLDivElement | null) => void;
};

export const TokenEditorToken: React.FC<Props> = ({
  token,
  index,
  forceChanged = false,
  isSelected,
  editingRange,
  tokens,
  tokenFontSize,
  editText,
  editInputRef,
  suppressBlurCommitRef,
  t,
  measureTextWidth,
  updateEditText,
  commitEdit,
  cancelEdit,
  setSelection,
  beginEdit,
  handleDragStart,
  handleDragOverToken,
  handleDropAt,
  handleDragEnd,
  handleTokenClick,
  setTokenRef,
}) => {
  const isMovePlaceholder = Boolean(token.moveId && token.kind === "empty");
  const isDeletionPlaceholder = Boolean(token.kind === "empty" && !token.moveId && token.previousTokens?.length);
  const hasHistory = forceChanged || (Boolean(token.previousTokens?.length) && !isMovePlaceholder);
  const isSpecial = token.kind === "special";
  const isEmpty = token.kind === "empty";
  const displayText =
    isDeletionPlaceholder
      ? "⬚"
      : isEmpty
        ? "⬚"
        : isSpecial && token.text.length > 32
          ? `${token.text.slice(0, 18)}…${token.text.slice(-10)}`
          : token.text;

  const style: React.CSSProperties = {
    ...(chipStyles[token.kind] || chipBase),
    ...(hasHistory ? chipStyles.changed : {}),
    cursor: isSpecial ? "default" : "pointer",
    userSelect: "none",
    position: "relative",
    fontSize: tokenFontSize,
    padding: 0,
    lineHeight: 1.05,
    marginRight: 0,
  };
  if (isEmpty) {
    Object.assign(style, {
      color: "#94a3b8",
      border: "1px dashed rgba(148,163,184,0.5)",
      borderRadius: 8,
      background: "rgba(15,23,42,0.15)",
      padding: "2px 6px",
      cursor: "pointer",
    });
    if (isMovePlaceholder) {
      const markerWidth = Math.max(2, Math.round(tokenFontSize * 0.12));
      const markerHeight = Math.max(14, Math.round(tokenFontSize * 1.1));
      Object.assign(style, {
        border: "none",
        background: "rgba(148,163,184,0.5)",
        padding: 0,
        width: markerWidth,
        minWidth: markerWidth,
        height: markerHeight,
        borderRadius: 2,
        color: "transparent",
        fontSize: 0,
      });
    } else if (isDeletionPlaceholder) {
      const ghostSize = Math.max(8, Math.round(tokenFontSize * 0.75));
      const ghostHeight = Math.max(14, Math.round(tokenFontSize * 1.05));
      Object.assign(style, {
        border: "none",
        background: "transparent",
        padding: "0 2px",
        borderRadius: 4,
        color: "#64748b",
        fontSize: ghostSize,
        lineHeight: `${ghostHeight}px`,
        height: ghostHeight,
        minHeight: ghostHeight,
      });
    }
  }
  if (isSelected) {
    Object.assign(
      style,
      chipStyles.selected,
      isEmpty
        ? {
            background: "rgba(14,165,233,0.25)",
            borderStyle: "solid",
            color: "#e2e8f0",
          }
        : {}
    );
  }
  const isEditingChip =
    editingRange &&
    index >= Math.min(editingRange.start!, editingRange.end!) &&
    index <= Math.max(editingRange.start!, editingRange.end!);
  if (isEditingChip) {
    if (index !== Math.min(editingRange!.start!, editingRange!.end!)) return null;
    const editStart = Math.min(editingRange!.start!, editingRange!.end!);
    const editEnd = Math.max(editingRange!.start!, editingRange!.end!);
    const originalSelection = buildEditableTextFromTokens(tokens.slice(editStart, editEnd + 1));
    const textForWidth = editText.length ? editText : originalSelection;
    const measuredPx = measureTextWidth(textForWidth);
    const editPxWidth = Math.max(8, measuredPx + tokenFontSize * 0.6);
    const selectedHighlight = chipStyles.selected;
    const editHeight = Math.max(24, tokenFontSize * 1.2);
    return (
      <div
        key={`edit-${index}`}
        style={{
          ...style,
          ...selectedHighlight,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(59,130,246,0.12)",
          width: `${editPxWidth}px`,
          minWidth: `${editPxWidth}px`,
          maxWidth: `${editPxWidth}px`,
          height: editHeight,
          padding: "2px 6px",
          borderRadius: 10,
          border: "1px solid rgba(148,163,184,0.25)",
          flex: "0 0 auto",
          boxSizing: "border-box",
        }}
      >
        <input
          ref={editInputRef as React.RefObject<HTMLInputElement>}
          style={{
            width: "100%",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "#e4f4ec",
            fontSize: tokenFontSize,
            lineHeight: 1.05,
            padding: 0,
            margin: 0,
          }}
          value={editText}
          onChange={(e) => updateEditText(e.target.value)}
          onBlur={() => {
            if (suppressBlurCommitRef.current) {
              suppressBlurCommitRef.current = false;
              return;
            }
            commitEdit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
              setSelection({ start: null, end: null });
            }
          }}
          autoFocus
          placeholder={t("tokenEditor.editPlaceholder")}
        />
      </div>
    );
  }
  return (
    <div
      key={token.id}
      style={style}
      data-token-index={index}
      draggable={!isSpecial && !isEmpty}
      onDragStart={(e) => {
        if (isSpecial || isEmpty) {
          e.preventDefault();
          return;
        }
        handleDragStart(index, e);
      }}
      onDragOver={(e) => handleDragOverToken(index, e)}
      onDrop={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const isAfter = (e.clientX - rect.left) / Math.max(1, rect.width) > 0.5;
        const targetIndex = isAfter ? index + 1 : index;
        handleDropAt(targetIndex);
      }}
      onDragEnd={handleDragEnd}
      onClick={(e) => {
        if (isSpecial) return;
        handleTokenClick(index, e.ctrlKey || e.metaKey);
      }}
      onDoubleClick={(e) => {
        if (isSpecial || isEmpty) return;
        const range = expandEditRangeToTokenGroup(tokens, index);
        setSelection(range);
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const caret = estimateCaretIndexFromClick(e.clientX, rect, token.text);
        beginEdit(range, caret);
      }}
      title={token.kind === "empty" ? "Empty placeholder" : token.text}
      role="button"
      aria-label={isEmpty ? "⬚" : undefined}
      tabIndex={isSpecial ? -1 : 0}
      ref={(el) => {
        setTokenRef(token.id, el);
      }}
      aria-pressed={isSelected}
    >
      <span>{displayText}</span>
    </div>
  );
};
