/**
 * Inline edit lifecycle for token text corrections.
 */
import { RefObject, useCallback } from "react";

import { SelectionRange } from "./useEditorUIState";
import { Token, buildEditableTextFromTokens, isInsertPlaceholder } from "../components/TokenEditorModel";

type UseTokenInlineEditArgs = {
  tokens: Token[];
  hasSelection: boolean;
  selection: SelectionRange;
  editingRange: SelectionRange | null;
  editText: string;
  editInputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  suppressBlurCommitRef: RefObject<boolean>;
  startEdit: (range: SelectionRange, text: string) => void;
  endEdit: () => void;
  setSelection: (range: SelectionRange) => void;
  setPendingSelectIndex: (index: number) => void;
  editSelectedRangeAsText: (range: [number, number], newText: string) => void;
  cancelInsertPlaceholder: (range: [number, number]) => void;
};

export const useTokenInlineEdit = ({
  tokens,
  hasSelection,
  selection,
  editingRange,
  editText,
  editInputRef,
  suppressBlurCommitRef,
  startEdit,
  endEdit,
  setSelection,
  setPendingSelectIndex,
  editSelectedRangeAsText,
  cancelInsertPlaceholder,
}: UseTokenInlineEditArgs) => {
  const beginEdit = useCallback(
    (range?: { start: number; end: number }, caretIndex?: number) => {
      const activeRange =
        range ??
        (hasSelection
          ? { start: Math.min(selection.start!, selection.end!), end: Math.max(selection.start!, selection.end!) }
          : null);
      if (!activeRange) return;

      const slice = tokens.slice(activeRange.start, activeRange.end + 1);
      if (slice.some((token) => token.kind === "empty" || token.kind === "special")) {
        return;
      }

      const editValue = buildEditableTextFromTokens(slice);
      suppressBlurCommitRef.current = false;
      startEdit(activeRange, editValue);
      const desiredCaret = typeof caretIndex === "number" ? caretIndex : editValue.length;
      setTimeout(() => {
        if (!editInputRef.current) return;
        const target = editInputRef.current;
        const pos = Math.max(0, Math.min(desiredCaret, target.value.length));
        target.focus();
        if (typeof target.setSelectionRange === "function") {
          target.setSelectionRange(pos, pos);
        }
      }, 10);
    },
    [editInputRef, hasSelection, selection, startEdit, suppressBlurCommitRef, tokens]
  );

  const commitEdit = useCallback(() => {
    if (!editingRange || editingRange.start === null || editingRange.end === null) return;
    const { start, end } = editingRange;
    setPendingSelectIndex(start);
    editSelectedRangeAsText([start, end], editText);
    suppressBlurCommitRef.current = false;
    endEdit();
    setSelection({ start, end });
  }, [
    editSelectedRangeAsText,
    editText,
    editingRange,
    endEdit,
    setPendingSelectIndex,
    setSelection,
    suppressBlurCommitRef,
  ]);

  const cancelEdit = useCallback(() => {
    suppressBlurCommitRef.current = true;
    if (editingRange && editingRange.start !== null && editingRange.end !== null) {
      const start = Math.min(editingRange.start, editingRange.end);
      const end = Math.max(editingRange.start, editingRange.end);
      const slice = tokens.slice(start, end + 1);
      if (isInsertPlaceholder(slice)) {
        cancelInsertPlaceholder([start, end]);
      }
    }
    endEdit();
  }, [cancelInsertPlaceholder, editingRange, endEdit, suppressBlurCommitRef, tokens]);

  return {
    beginEdit,
    commitEdit,
    cancelEdit,
  };
};
