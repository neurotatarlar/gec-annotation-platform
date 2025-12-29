import { useEffect, useRef, type Dispatch } from "react";

import { EditorPresentState } from "../components/TokenEditorModel";

type HydrationResult = {
  present: EditorPresentState;
  typeMap: Record<string, number | null>;
  spanMap: Map<string, number>;
};

type UseAnnotationsLoaderParams = {
  textId: number;
  currentUserId?: string | null;
  get: (url: string, options?: any) => Promise<any>;
  hydrateFromServerAnnotations: (items: any[]) => HydrationResult | null;
  dispatch: Dispatch<any>;
  seedCorrectionTypes: (typeMap: Record<string, number | null>) => void;
  pendingLocalStateRef: React.RefObject<EditorPresentState | null>;
  hydratedFromServerRef: React.RefObject<boolean>;
  annotationIdMap: React.RefObject<Map<string, number>>;
  annotationDeleteMap: React.RefObject<Map<string, number[]>>;
  setServerAnnotationVersion: (value: number) => void;
};

export const useAnnotationsLoader = ({
  textId,
  currentUserId,
  get,
  hydrateFromServerAnnotations,
  dispatch,
  seedCorrectionTypes,
  pendingLocalStateRef,
  hydratedFromServerRef,
  annotationIdMap,
  annotationDeleteMap,
  setServerAnnotationVersion,
}: UseAnnotationsLoaderParams) => {
  const loadedRef = useRef<number | null>(null);
  const promiseRef = useRef<Promise<any> | null>(null);
  const promiseTextIdRef = useRef<number | null>(null);

  useEffect(() => {
    loadedRef.current = null;
    promiseRef.current = null;
    promiseTextIdRef.current = null;
  }, [textId]);

  useEffect(() => {
    let cancelled = false;
    if (loadedRef.current === textId) return () => {};
    const loadExistingAnnotations = async () => {
      try {
        let promise = promiseRef.current;
        if (!promise || promiseTextIdRef.current !== textId) {
          promiseTextIdRef.current = textId;
          promise = get(`/api/texts/${textId}/annotations`, { params: { all_authors: true } });
          promiseRef.current = promise;
        }
        const res = await promise;
        if (cancelled) return;
        const items = Array.isArray(res.data) ? res.data : [];
        const deleteMap = new Map<string, number[]>();
        items.forEach((ann: any) => {
          if (ann?.id == null) return;
          if (typeof ann.start_token !== "number" || typeof ann.end_token !== "number") return;
          const key = `${ann.start_token}-${ann.end_token}`;
          const existing = deleteMap.get(key) ?? [];
          existing.push(ann.id);
          deleteMap.set(key, existing);
        });
        annotationDeleteMap.current = deleteMap;
        const maxVersion = items.reduce((acc: number, ann: any) => Math.max(acc, ann?.version ?? 0), 0);
        setServerAnnotationVersion(maxVersion);
        const hydrated = hydrateFromServerAnnotations(items);
        if (hydrated && !hydratedFromServerRef.current) {
          dispatch({ type: "INIT_FROM_STATE", state: hydrated.present });
          seedCorrectionTypes(hydrated.typeMap);
          annotationIdMap.current = hydrated.spanMap;
          hydratedFromServerRef.current = true;
        } else if (!hydratedFromServerRef.current && pendingLocalStateRef.current) {
          dispatch({ type: "INIT_FROM_STATE", state: pendingLocalStateRef.current });
          hydratedFromServerRef.current = true;
        } else {
          annotationIdMap.current = new Map<string, number>();
          items.forEach((ann: any) => {
            if (
              ann?.id != null &&
              typeof ann.start_token === "number" &&
              typeof ann.end_token === "number" &&
              (!currentUserId || ann.author_id === currentUserId)
            ) {
              const key = `${ann.start_token}-${ann.end_token}`;
              annotationIdMap.current.set(key, ann.id);
            }
          });
        }
        if (!items.length) {
          annotationIdMap.current = new Map<string, number>();
          annotationDeleteMap.current = new Map<string, number[]>();
        }
        loadedRef.current = textId;
      } catch {
        // ignore load errors; optimistic saves will still work
      } finally {
        if (promiseTextIdRef.current === textId) {
          promiseRef.current = null;
        }
      }
    };
    loadExistingAnnotations();
    return () => {
      cancelled = true;
    };
  }, [
    textId,
    currentUserId,
    get,
    hydrateFromServerAnnotations,
    dispatch,
    seedCorrectionTypes,
    pendingLocalStateRef,
    hydratedFromServerRef,
    annotationIdMap,
    annotationDeleteMap,
    setServerAnnotationVersion,
  ]);
};
