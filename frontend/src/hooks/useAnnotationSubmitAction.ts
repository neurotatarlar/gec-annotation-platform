/**
 * Coordinates final annotation submission after save and submit-readiness validation.
 */
import { useCallback, useState } from "react";

import { DraftCorrection, getDraftCorrectionSubmitReadiness } from "../components/TokenEditorModel";

type UseAnnotationSubmitActionArgs = {
  textId: number;
  buildSubmitCorrections: () => Promise<Pick<DraftCorrection, "clientId" | "operation" | "errorTypeId">[]>;
  saveAnnotations: () => Promise<void>;
  post: (url: string, payload?: any, options?: any) => Promise<any>;
  requestNextText: () => Promise<boolean>;
  setLastDecision: (decision: "skip" | "trash" | "submit" | null) => void;
  setActionError: (message: string | null) => void;
  setActionMessage: (message: string | null) => void;
  formatError: (error: any) => string;
};

export const useAnnotationSubmitAction = ({
  textId,
  buildSubmitCorrections,
  saveAnnotations,
  post,
  requestNextText,
  setLastDecision,
  setActionError,
  setActionMessage,
  formatError,
}: UseAnnotationSubmitActionArgs) => {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    const draftCorrections = await buildSubmitCorrections();
    const submitReadiness = getDraftCorrectionSubmitReadiness(draftCorrections);
    if (!submitReadiness.canSubmit) {
      setActionError("Please assign an error type to all corrections.");
      return;
    }
    setActionError(null);
    setActionMessage(null);
    setIsSubmitting(true);
    try {
      await saveAnnotations();
      await post(`/api/texts/${textId}/submit`);
      setLastDecision("submit");
      await requestNextText();
    } catch (error: any) {
      setActionError(formatError(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    buildSubmitCorrections,
    formatError,
    post,
    requestNextText,
    saveAnnotations,
    setActionError,
    setActionMessage,
    setLastDecision,
    textId,
  ]);

  return {
    handleSubmit,
    isSubmitting,
  };
};
