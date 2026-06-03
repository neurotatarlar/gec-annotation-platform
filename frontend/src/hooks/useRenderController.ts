/**
 * Coordinates backend rendering of corrected annotation text.
 */
import { useEffect, useMemo, useRef, useState } from "react";

type UseRenderControllerArgs = {
  textId: number;
  resetKey: unknown;
  tokensLength: number;
  correctionCount: number;
  hasLoadedAnnotations: boolean;
  localCorrectedText: string;
  buildRenderPayload: () => Promise<unknown[]>;
  post: (url: string, payload: unknown, options?: any) => Promise<any>;
  debounceMs?: number;
};

export const useRenderController = ({
  textId,
  resetKey,
  tokensLength,
  correctionCount,
  hasLoadedAnnotations,
  localCorrectedText,
  buildRenderPayload,
  post,
  debounceMs = 450,
}: UseRenderControllerArgs) => {
  const [renderEpoch, setRenderEpoch] = useState(0);
  const [canonicalEpoch, setCanonicalEpoch] = useState(0);
  const [canonicalCorrectedText, setCanonicalCorrectedText] = useState<string | null>(null);
  const [isRenderPending, setIsRenderPending] = useState(false);
  const [hasCanonicalRender, setHasCanonicalRender] = useState(false);
  const renderRequestIdRef = useRef(0);
  const renderAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    renderRequestIdRef.current += 1;
    setRenderEpoch(0);
    setCanonicalEpoch(0);
    setCanonicalCorrectedText(null);
    setIsRenderPending(false);
    setHasCanonicalRender(false);
    if (renderAbortRef.current) {
      renderAbortRef.current.abort();
      renderAbortRef.current = null;
    }
  }, [resetKey]);

  useEffect(() => {
    if (process.env.NODE_ENV === "test") return;
    if (!tokensLength) return;
    renderRequestIdRef.current += 1;
    const requestId = renderRequestIdRef.current;
    setRenderEpoch(requestId);
    if (correctionCount === 0) {
      setCanonicalCorrectedText(localCorrectedText);
      setCanonicalEpoch(requestId);
      setIsRenderPending(false);
      if (hasLoadedAnnotations) {
        setHasCanonicalRender(true);
      }
      return;
    }
    setIsRenderPending(true);
    let timer: number | null = window.setTimeout(async () => {
      if (renderAbortRef.current) {
        renderAbortRef.current.abort();
      }
      const controller = new AbortController();
      renderAbortRef.current = controller;
      try {
        const annotations = await buildRenderPayload();
        const response = await post(
          `/api/texts/${textId}/render`,
          { annotations },
          { signal: controller.signal }
        );
        if (renderRequestIdRef.current !== requestId) return;
        const correctedText = response?.data?.corrected_text ?? localCorrectedText;
        setCanonicalCorrectedText(correctedText);
        setCanonicalEpoch(requestId);
        setHasCanonicalRender(true);
      } catch {
        if (!controller.signal.aborted && renderRequestIdRef.current === requestId) {
          setCanonicalCorrectedText(localCorrectedText);
          setCanonicalEpoch(requestId);
          setHasCanonicalRender(true);
        }
      } finally {
        if (renderRequestIdRef.current === requestId) {
          setIsRenderPending(false);
          timer = null;
        }
      }
    }, debounceMs);
    return () => {
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [
    buildRenderPayload,
    correctionCount,
    debounceMs,
    hasLoadedAnnotations,
    localCorrectedText,
    post,
    textId,
    tokensLength,
  ]);

  useEffect(() => {
    return () => {
      if (renderAbortRef.current) {
        renderAbortRef.current.abort();
      }
    };
  }, []);

  const correctedText = useMemo(() => {
    if (canonicalEpoch === renderEpoch && canonicalCorrectedText != null) {
      return canonicalCorrectedText;
    }
    return localCorrectedText;
  }, [canonicalCorrectedText, canonicalEpoch, localCorrectedText, renderEpoch]);

  return {
    correctedText,
    isRenderPending,
    hasCanonicalRender,
  };
};
