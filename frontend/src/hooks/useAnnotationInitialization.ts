/**
 * Hook for text-level annotation initialization and server hydration wiring.
 */
import { useCallback, useEffect, useRef, type Dispatch, type RefObject } from "react";

import {
  EditorPresentState,
  hydrateFromServerAnnotations as hydrateFromServerAnnotationsModel,
} from "../components/TokenEditorModel";
import { loadEditorState } from "../components/TokenEditorStorage";

type HydrationResult = ReturnType<typeof hydrateFromServerAnnotationsModel>;

type UseAnnotationInitializationArgs = {
  textId: number;
  initialText: string;
  currentUserId?: string | null;
  dispatch: Dispatch<any>;
  resetUI: () => void;
  setServerAnnotationVersion: (value: number) => void;
  setHasLoadedAnnotations: (value: boolean) => void;
};

type UseAnnotationInitializationResult = {
  lastSavedSignatureRef: RefObject<string | null>;
  pendingLocalStateRef: RefObject<EditorPresentState | null>;
  hydratedFromServerRef: RefObject<boolean>;
  hydrateFromServerAnnotations: (items: any[]) => HydrationResult;
};

export const useAnnotationInitialization = ({
  textId,
  initialText,
  currentUserId,
  dispatch,
  resetUI,
  setServerAnnotationVersion,
  setHasLoadedAnnotations,
}: UseAnnotationInitializationArgs): UseAnnotationInitializationResult => {
  const lastSavedSignatureRef = useRef<string | null>(null);
  const pendingLocalStateRef = useRef<EditorPresentState | null>(null);
  const hydratedFromServerRef = useRef(false);

  useEffect(() => {
    setServerAnnotationVersion(0);
    hydratedFromServerRef.current = false;
    resetUI();
    setHasLoadedAnnotations(false);
  }, [resetUI, setHasLoadedAnnotations, setServerAnnotationVersion, textId]);

  useEffect(() => {
    const saved = loadEditorState(textId);
    if (saved) {
      pendingLocalStateRef.current = saved;
      dispatch({ type: "INIT_FROM_STATE", state: saved });
    } else {
      pendingLocalStateRef.current = null;
      dispatch({ type: "INIT_FROM_TEXT", text: initialText });
    }
    lastSavedSignatureRef.current = null;
  }, [dispatch, initialText, textId]);

  const hydrateFromServerAnnotations = useCallback(
    (items: any[]) =>
      hydrateFromServerAnnotationsModel({
        items,
        initialText,
        currentUserId,
      }),
    [initialText, currentUserId]
  );

  return {
    lastSavedSignatureRef,
    pendingLocalStateRef,
    hydratedFromServerRef,
    hydrateFromServerAnnotations,
  };
};
