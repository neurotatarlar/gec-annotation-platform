import { EditorPresentState } from "./TokenEditorModel";
import { SpaceMarker } from "./TokenEditorSpacing";

export type TokenEditorPrefs = {
  tokenGap?: number;
  tokenFontSize?: number;
  spaceMarker?: SpaceMarker;
  lastDecision?: "skip" | "trash" | "submit" | null;
  lastTextId?: number;
  viewTab?: "original" | "corrected" | "m2";
  textPanelOpen?: boolean;
};

const PREFS_KEY = "tokenEditorPrefs";

export const normalizeSpaceMarker = (value: unknown): SpaceMarker => {
  return value === "dot" || value === "box" || value === "none" ? value : "box";
};

export const loadPrefs = (): TokenEditorPrefs => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (parsed.spaceMarker) {
        parsed.spaceMarker = normalizeSpaceMarker(parsed.spaceMarker);
      }
    }
    return parsed;
  } catch {
    return {};
  }
};

export const persistPrefs = (prefs: TokenEditorPrefs) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
};

const stateKey = (textId: number) => `${PREFS_KEY}:state:${textId}`;

export const loadEditorState = (textId: number): EditorPresentState | null => {
  if (process.env.NODE_ENV !== "test") return null;
  try {
    const raw = localStorage.getItem(stateKey(textId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.originalTokens || !parsed?.tokens) return null;
    return {
      originalTokens: parsed.originalTokens,
      tokens: parsed.tokens,
      operations: Array.isArray(parsed.operations) ? parsed.operations : [],
    } as EditorPresentState;
  } catch {
    return null;
  }
};

export const persistEditorState = (textId: number, state: EditorPresentState) => {
  if (process.env.NODE_ENV !== "test") return;
  try {
    localStorage.setItem(stateKey(textId), JSON.stringify(state));
  } catch {
    // ignore
  }
};
