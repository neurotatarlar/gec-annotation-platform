/**
 * Hook for editor UI state such as active tab and layout toggles.
 */
import { useCallback, useReducer } from "react";

export type SelectionRange = { start: number | null; end: number | null };

type EditorMode = "idle" | "selecting" | "editing";
type EditorOverlay = "none" | "clear" | "flag";

type EditorUIState = {
  mode: EditorMode;
  overlay: EditorOverlay;
  selection: SelectionRange;
  editingRange: SelectionRange | null;
  editText: string;
  pendingAction: "skip" | "trash" | null;
  flagReason: string;
  flagError: string | null;
};

type EditorUIAction =
  | { type: "RESET" }
  | { type: "SET_SELECTION"; range: SelectionRange }
  | { type: "START_EDIT"; range: SelectionRange; text: string }
  | { type: "UPDATE_EDIT_TEXT"; value: string }
  | { type: "END_EDIT" }
  | { type: "OPEN_CLEAR_CONFIRM" }
  | { type: "CLOSE_CLEAR_CONFIRM" }
  | { type: "OPEN_FLAG"; action: "skip" | "trash" }
  | { type: "UPDATE_FLAG_REASON"; value: string }
  | { type: "SET_FLAG_ERROR"; value: string | null }
  | { type: "CLOSE_FLAG" };

const EMPTY_SELECTION: SelectionRange = { start: null, end: null };

const baseEditorUIState: EditorUIState = {
  mode: "idle",
  overlay: "none",
  selection: EMPTY_SELECTION,
  editingRange: null,
  editText: "",
  pendingAction: null,
  flagReason: "",
  flagError: null,
};

const syncEditorMode = (state: EditorUIState): EditorUIState => {
  let mode: EditorMode = "idle";
  if (state.editingRange) {
    mode = "editing";
  } else if (state.selection.start !== null && state.selection.end !== null) {
    mode = "selecting";
  }
  return state.mode === mode ? state : { ...state, mode };
};

const editorUIReducer = (state: EditorUIState, action: EditorUIAction): EditorUIState => {
  switch (action.type) {
    case "RESET":
      return baseEditorUIState;
    case "SET_SELECTION": {
      const range = action.range;
      const next: EditorUIState = { ...state, selection: range };
      return syncEditorMode(next);
    }
    case "START_EDIT": {
      const next: EditorUIState = {
        ...state,
        editingRange: action.range,
        editText: action.text,
      };
      return syncEditorMode(next);
    }
    case "UPDATE_EDIT_TEXT":
      return { ...state, editText: action.value };
    case "END_EDIT": {
      const next: EditorUIState = {
        ...state,
        editingRange: null,
        editText: "",
      };
      return syncEditorMode(next);
    }
    case "OPEN_CLEAR_CONFIRM":
      return { ...state, overlay: "clear" };
    case "CLOSE_CLEAR_CONFIRM":
      return { ...state, overlay: "none" };
    case "OPEN_FLAG":
      return { ...state, overlay: "flag", pendingAction: action.action, flagReason: "", flagError: null };
    case "UPDATE_FLAG_REASON":
      return { ...state, flagReason: action.value };
    case "SET_FLAG_ERROR":
      return { ...state, flagError: action.value };
    case "CLOSE_FLAG":
      return { ...state, overlay: "none", pendingAction: null, flagReason: "", flagError: null };
    default:
      return state;
  }
};

export const useEditorUIState = () => {
  const [ui, dispatch] = useReducer(editorUIReducer, baseEditorUIState);

  const setSelection = useCallback((range: SelectionRange) => {
    dispatch({ type: "SET_SELECTION", range });
  }, []);
  const startEdit = useCallback((range: SelectionRange, text: string) => {
    dispatch({ type: "START_EDIT", range, text });
  }, []);
  const updateEditText = useCallback((value: string) => {
    dispatch({ type: "UPDATE_EDIT_TEXT", value });
  }, []);
  const endEdit = useCallback(() => {
    dispatch({ type: "END_EDIT" });
  }, []);
  const openClearConfirm = useCallback(() => {
    dispatch({ type: "OPEN_CLEAR_CONFIRM" });
  }, []);
  const closeClearConfirm = useCallback(() => {
    dispatch({ type: "CLOSE_CLEAR_CONFIRM" });
  }, []);
  const openFlagConfirm = useCallback((action: "skip" | "trash") => {
    dispatch({ type: "OPEN_FLAG", action });
  }, []);
  const closeFlagConfirm = useCallback(() => {
    dispatch({ type: "CLOSE_FLAG" });
  }, []);
  const updateFlagReason = useCallback((value: string) => {
    dispatch({ type: "UPDATE_FLAG_REASON", value });
  }, []);
  const updateFlagError = useCallback((value: string | null) => {
    dispatch({ type: "SET_FLAG_ERROR", value });
  }, []);
  const resetUI = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  return {
    ui,
    setSelection,
    startEdit,
    updateEditText,
    endEdit,
    openClearConfirm,
    closeClearConfirm,
    openFlagConfirm,
    closeFlagConfirm,
    updateFlagReason,
    updateFlagError,
    resetUI,
  };
};
