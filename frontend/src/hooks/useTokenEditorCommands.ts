/**
 * Toolbar and shared command handlers for token editing.
 */
import { RefObject, useCallback } from "react";

import { SelectionRange } from "./useEditorUIState";

type DeleteRangeContext = { range: [number, number]; anchorIndex?: number };

type UseTokenEditorCommandsArgs = {
  editingRange: SelectionRange | null;
  selection: SelectionRange;
  selectedCount: number;
  hasSelectionTokens: boolean;
  selectionRef: RefObject<SelectionRange>;
  editInputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  suppressBlurCommitRef: RefObject<boolean>;
  cancelEdit: () => void;
  markSkipAutoSelect: () => void;
  getDeleteRange: () => DeleteRangeContext | null;
  setSelection: (range: SelectionRange) => void;
  startEdit: (range: SelectionRange, text: string) => void;
  undo: () => void;
  redo: () => void;
  deleteSelectedTokens: (context: DeleteRangeContext) => void;
  insertBeforeSelectedTokens: (range: [number, number]) => void;
  insertAfterSelectedTokens: (range: [number, number]) => void;
  mergeRange: (range: [number, number]) => void;
};

export const useTokenEditorCommands = ({
  editingRange,
  selection,
  selectedCount,
  hasSelectionTokens,
  selectionRef,
  editInputRef,
  suppressBlurCommitRef,
  cancelEdit,
  markSkipAutoSelect,
  getDeleteRange,
  setSelection,
  startEdit,
  undo,
  redo,
  deleteSelectedTokens,
  insertBeforeSelectedTokens,
  insertAfterSelectedTokens,
  mergeRange,
}: UseTokenEditorCommandsArgs) => {
  const performUndo = useCallback(() => {
    if (editingRange) {
      cancelEdit();
    }
    markSkipAutoSelect();
    setSelection({ start: null, end: null });
    undo();
  }, [cancelEdit, editingRange, markSkipAutoSelect, setSelection, undo]);

  const performRedo = useCallback(() => {
    if (editingRange) {
      cancelEdit();
    }
    markSkipAutoSelect();
    setSelection({ start: null, end: null });
    redo();
  }, [cancelEdit, editingRange, markSkipAutoSelect, redo, setSelection]);

  const handleDeleteSelection = useCallback(() => {
    if (!hasSelectionTokens) return;
    const ctx = getDeleteRange();
    if (!ctx) return;
    deleteSelectedTokens(ctx);
    setSelection({ start: null, end: null });
  }, [deleteSelectedTokens, getDeleteRange, hasSelectionTokens, setSelection]);

  const focusInsertedToken = useCallback(() => {
    setTimeout(() => {
      if (!editInputRef.current) return;
      editInputRef.current.focus();
      if (typeof editInputRef.current.setSelectionRange === "function") {
        editInputRef.current.setSelectionRange(0, 0);
      }
    }, 10);
  }, [editInputRef]);

  const handleInsertBeforeSelection = useCallback(() => {
    if (!hasSelectionTokens) return;
    const currentSelection = selectionRef.current;
    if (currentSelection.start === null || currentSelection.end === null) return;
    const [s, e] = [currentSelection.start, currentSelection.end];
    const start = Math.min(s, e);
    insertBeforeSelectedTokens([start, Math.max(s, e)]);
    setSelection({ start, end: start });
    suppressBlurCommitRef.current = false;
    startEdit({ start, end: start }, "");
    focusInsertedToken();
  }, [
    focusInsertedToken,
    hasSelectionTokens,
    insertBeforeSelectedTokens,
    selectionRef,
    setSelection,
    startEdit,
    suppressBlurCommitRef,
  ]);

  const handleInsertAfterSelection = useCallback(() => {
    if (!hasSelectionTokens) return;
    const currentSelection = selectionRef.current;
    if (currentSelection.start === null || currentSelection.end === null) return;
    const [s, e] = [currentSelection.start, currentSelection.end];
    const start = Math.min(s, e);
    const end = Math.max(s, e);
    insertAfterSelectedTokens([start, end]);
    const newIndex = end + 1;
    setSelection({ start: newIndex, end: newIndex });
    suppressBlurCommitRef.current = false;
    startEdit({ start: newIndex, end: newIndex }, "");
    focusInsertedToken();
  }, [
    focusInsertedToken,
    hasSelectionTokens,
    insertAfterSelectedTokens,
    selectionRef,
    setSelection,
    startEdit,
    suppressBlurCommitRef,
  ]);

  const handleMergeSelection = useCallback(() => {
    if (!hasSelectionTokens || selectedCount < 2 || selection.start === null || selection.end === null) return;
    const start = Math.min(selection.start, selection.end);
    const end = Math.max(selection.start, selection.end);
    mergeRange([start, end]);
    setSelection({ start: null, end: null });
  }, [hasSelectionTokens, mergeRange, selectedCount, selection, setSelection]);

  return {
    performUndo,
    performRedo,
    handleDeleteSelection,
    handleInsertBeforeSelection,
    handleInsertAfterSelection,
    handleMergeSelection,
  };
};
