/**
 * Global keyboard commands for the token editor.
 */
import { RefObject, useEffect } from "react";

import { SelectionRange } from "./useEditorUIState";

type DeleteRangeContext = { range: [number, number]; anchorIndex?: number };

type UseTokenEditorKeyboardShortcutsArgs = {
  enabled?: boolean;
  editingRange: SelectionRange | null;
  editText: string;
  selectionRef: RefObject<SelectionRange>;
  editInputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  suppressBlurCommitRef: RefObject<boolean>;
  showClearConfirm: boolean;
  pendingAction: "skip" | "trash" | null;
  performUndo: () => void;
  performRedo: () => void;
  cancelEdit: () => void;
  commitEdit: () => void;
  beginEdit: (range?: { start: number; end: number }, caretIndex?: number) => void;
  closeClearConfirm: () => void;
  cancelFlag: () => void;
  getDeleteRange: () => DeleteRangeContext | null;
  deleteSelectedTokens: (context: DeleteRangeContext) => void;
  insertAfterSelectedTokens: (range: [number, number]) => void;
  setSelection: (range: SelectionRange) => void;
  startEdit: (range: SelectionRange, text: string) => void;
};

const isEditableInputTarget = (target: HTMLElement | null) =>
  target &&
  (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || (target as HTMLInputElement).isContentEditable);

export const useTokenEditorKeyboardShortcuts = ({
  enabled = true,
  editingRange,
  editText,
  selectionRef,
  editInputRef,
  suppressBlurCommitRef,
  showClearConfirm,
  pendingAction,
  performUndo,
  performRedo,
  cancelEdit,
  commitEdit,
  beginEdit,
  closeClearConfirm,
  cancelFlag,
  getDeleteRange,
  deleteSelectedTokens,
  insertAfterSelectedTokens,
  setSelection,
  startEdit,
}: UseTokenEditorKeyboardShortcutsArgs) => {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isInput = isEditableInputTarget(target);
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const key = event.key?.toLowerCase();
      const code = event.code?.toLowerCase();
      const isKeyZ = key === "z" || code === "keyz";
      const isKeyY = key === "y" || code === "keyy";
      const isUndoKey = ctrlOrMeta && isKeyZ && !event.shiftKey;
      const isRedoKey = ctrlOrMeta && (isKeyY || (event.shiftKey && isKeyZ));

      if (isUndoKey || isRedoKey) {
        event.preventDefault();
        if (isUndoKey) {
          performUndo();
        } else {
          performRedo();
        }
        return;
      }

      if (editingRange) {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelEdit();
          setSelection({ start: null, end: null });
        } else if (event.key === "Enter") {
          event.preventDefault();
          commitEdit();
        }
        return;
      }

      if (showClearConfirm && event.key === "Escape") {
        event.preventDefault();
        closeClearConfirm();
        return;
      }

      if (pendingAction && event.key === "Escape") {
        event.preventDefault();
        cancelFlag();
        return;
      }

      if (isInput && !(isUndoKey || isRedoKey)) return;

      if (isUndoKey) {
        event.preventDefault();
        performUndo();
        return;
      }

      if (isRedoKey) {
        event.preventDefault();
        performRedo();
        return;
      }

      const currentSelection = selectionRef.current;
      const hasSelectionNow = currentSelection.start !== null && currentSelection.end !== null;

      if (event.key === "Delete" || event.key === "Backspace") {
        if (hasSelectionNow) {
          event.preventDefault();
          const ctx = getDeleteRange();
          if (ctx) {
            deleteSelectedTokens(ctx);
            setSelection({ start: null, end: null });
          }
        }
      }

      if (event.key === "Insert") {
        if (!hasSelectionNow) return;
        event.preventDefault();
        const [s, e] = [currentSelection.start!, currentSelection.end!];
        const start = Math.min(s, e);
        const end = Math.max(s, e);
        insertAfterSelectedTokens([start, end]);
        const newIndex = end + 1;
        setSelection({ start: newIndex, end: newIndex });
        suppressBlurCommitRef.current = false;
        startEdit({ start: newIndex, end: newIndex }, "");
        setTimeout(() => editInputRef.current?.focus(), 10);
      }

      if (event.key === "Escape") {
        setSelection({ start: null, end: null });
      }

      if (event.key === "Enter" && hasSelectionNow) {
        event.preventDefault();
        beginEdit(undefined, editText.length);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    enabled,    beginEdit,
    cancelEdit,
    cancelFlag,
    closeClearConfirm,
    commitEdit,
    deleteSelectedTokens,
    editInputRef,
    editText,
    editingRange,
    getDeleteRange,
    insertAfterSelectedTokens,
    pendingAction,
    performRedo,
    performUndo,
    selectionRef,
    setSelection,
    showClearConfirm,
    startEdit,
    suppressBlurCommitRef,
  ]);
};
