/**
 * Coordinates saving annotations with debounce, optimistic updates, and server reconciliation.
 * Exposes save/flush helpers and integrates render responses.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

import { AnnotationDraft, AnnotationSavePayload, SaveStatus } from "../types";
import { shouldSkipSave } from "../components/TokenEditorModel";

type UseSaveControllerArgs = {
  tokens: unknown[];
  buildAnnotationsPayload: () => Promise<AnnotationDraft[]>;
  post: (url: string, payload: AnnotationSavePayload) => Promise<any>;
  textId: number;
  serverAnnotationVersion: number;
  setServerAnnotationVersion: (version: number) => void;
  annotationIdMap: MutableRefObject<Map<string, number>>;
  lastSavedSignatureRef: MutableRefObject<string | null>;
  formatError: (error: any) => string;
  setActionError: (message: string | null) => void;
  onSaveStatusChange?: (status: SaveStatus) => void;
  statusTrigger?: unknown;
  autosaveDelayMs?: number;
};

export const useSaveController = ({
  tokens,
  buildAnnotationsPayload,
  post,
  textId,
  serverAnnotationVersion,
  setServerAnnotationVersion,
  annotationIdMap,
  lastSavedSignatureRef,
  formatError,
  setActionError,
  onSaveStatusChange,
  statusTrigger,
  autosaveDelayMs = 800,
}: UseSaveControllerArgs) => {
  const [isAutosaving, setIsAutosaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus["state"]>("idle");
  const autosaveInitializedRef = useRef(false);
  const inFlightSignatureRef = useRef<string | null>(null);
  const inFlightPromiseRef = useRef<Promise<void> | null>(null);

  const saveAnnotations = useCallback(async () => {
    const annotations = await buildAnnotationsPayload();
    const embeddedDeletedIds = Array.isArray((annotations as any).deleted_ids)
      ? ((annotations as any).deleted_ids as number[])
      : null;
    const spans = new Set(annotations.map((ann) => `${ann.start_token}-${ann.end_token}`));
    const deletedIds =
      embeddedDeletedIds ??
      (annotationIdMap.current
        ? Array.from(annotationIdMap.current.entries())
            .filter(([spanKey]) => !spans.has(spanKey))
            .map(([, id]) => id)
        : []);
    const { skip, nextSignature } = shouldSkipSave(lastSavedSignatureRef.current, annotations);
    if (skip) {
      lastSavedSignatureRef.current = nextSignature;
      setHasUnsavedChanges(false);
      setSaveStatus("saved");
      return;
    }
    if (
      inFlightSignatureRef.current === nextSignature &&
      inFlightPromiseRef.current
    ) {
      return inFlightPromiseRef.current;
    }
    const payload: AnnotationSavePayload = {
      annotations,
      client_version: serverAnnotationVersion,
    };
    if (deletedIds.length) {
      payload.deleted_ids = deletedIds;
    }
    const request = (async () => {
      const response = await post(`/api/texts/${textId}/annotations`, payload);
      lastSavedSignatureRef.current = nextSignature;
      const items = Array.isArray(response.data) ? response.data : [];
      annotationIdMap.current = new Map<string, number>();
      items.forEach((ann: any) => {
        if (ann?.id != null && typeof ann.start_token === "number" && typeof ann.end_token === "number") {
          const spanKey = `${ann.start_token}-${ann.end_token}`;
          annotationIdMap.current.set(spanKey, ann.id);
        }
      });
      const maxVersion = items.reduce(
        (acc: number, ann: any) => Math.max(acc, ann?.version ?? serverAnnotationVersion),
        serverAnnotationVersion
      );
      setServerAnnotationVersion(maxVersion || serverAnnotationVersion + 1);
    })();
    inFlightSignatureRef.current = nextSignature;
    inFlightPromiseRef.current = request;
    try {
      await request;
    } finally {
      if (inFlightSignatureRef.current === nextSignature) {
        inFlightSignatureRef.current = null;
        inFlightPromiseRef.current = null;
      }
    }
  }, [
    annotationIdMap,
    buildAnnotationsPayload,
    lastSavedSignatureRef,
    post,
    serverAnnotationVersion,
    setServerAnnotationVersion,
    textId,
  ]);

  useEffect(() => {
    if (process.env.NODE_ENV === "test") return;
    if (!tokens.length) return;
    if (!autosaveInitializedRef.current) {
      autosaveInitializedRef.current = true;
      return;
    }
    setHasUnsavedChanges(true);
    setSaveStatus("idle");
    let timer: number | null = window.setTimeout(async () => {
      setIsAutosaving(true);
      setSaveStatus("saving");
      setActionError(null);
      try {
        await saveAnnotations();
        setHasUnsavedChanges(false);
        setSaveStatus("saved");
      } catch (error: any) {
        setActionError(formatError(error));
        setSaveStatus("error");
      } finally {
        setIsAutosaving(false);
        timer = null;
      }
    }, autosaveDelayMs);

    return () => {
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [autosaveDelayMs, formatError, saveAnnotations, setActionError, tokens]);

  const lastEmittedStatus = useRef<SaveStatus | null>(null);
  useEffect(() => {
    const next: SaveStatus = { state: saveStatus, unsaved: hasUnsavedChanges };
    if (
      lastEmittedStatus.current?.state !== next.state ||
      lastEmittedStatus.current?.unsaved !== next.unsaved
    ) {
      lastEmittedStatus.current = next;
      onSaveStatusChange?.(next);
    }
  }, [saveStatus, hasUnsavedChanges, onSaveStatusChange, statusTrigger]);

  return {
    saveAnnotations,
    isAutosaving,
    hasUnsavedChanges,
    saveStatus,
  };
};
