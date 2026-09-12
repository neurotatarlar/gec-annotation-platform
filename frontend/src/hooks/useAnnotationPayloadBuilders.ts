/**
 * Payload builder callbacks for annotation save, render preview, and submit.
 */
import { RefObject, useCallback } from "react";

import {
  CorrectionCardLite,
  MoveMarker,
  Token,
  buildAnnotationsPayloadStandalone,
  buildDraftCorrectionsStandalone,
} from "../components/TokenEditorModel";

type UseAnnotationPayloadBuildersArgs = {
  initialText: string;
  tokens: Token[];
  originalTokens: Token[];
  correctionCards: CorrectionCardLite[];
  correctionTypeMap: Record<string, number | null>;
  moveMarkers: MoveMarker[];
  annotationIdMap: RefObject<Map<string, number>>;
  annotationDeleteMap: RefObject<Map<string, number[]>>;
};

export const useAnnotationPayloadBuilders = ({
  initialText,
  tokens,
  originalTokens,
  correctionCards,
  correctionTypeMap,
  moveMarkers,
  annotationIdMap,
  annotationDeleteMap,
}: UseAnnotationPayloadBuildersArgs) => {
  const buildBaseInput = useCallback(
    () => ({
      initialText,
      tokens,
      originalTokens,
      correctionCards,
      correctionTypeMap,
      moveMarkers,
      annotationIdMap: annotationIdMap.current,
    }),
    [annotationIdMap, correctionCards, correctionTypeMap, initialText, moveMarkers, originalTokens, tokens]
  );

  const buildAnnotationsPayload = useCallback(
    () =>
      buildAnnotationsPayloadStandalone({
        ...buildBaseInput(),
        annotationDeleteMap: annotationDeleteMap.current,
        includeDeletedIds: true,
        allowUnassigned: true,
        includeClientCorrectionId: true,
      }),
    [annotationDeleteMap, buildBaseInput]
  );

  const buildRenderPayload = useCallback(
    () =>
      buildAnnotationsPayloadStandalone({
        ...buildBaseInput(),
        allowUnassigned: true,
        includeClientCorrectionId: true,
      }),
    [buildBaseInput]
  );

  const buildSubmitCorrections = useCallback(
    () =>
      buildDraftCorrectionsStandalone({
        ...buildBaseInput(),
        allowUnassigned: true,
      }),
    [buildBaseInput]
  );

  return {
    buildAnnotationsPayload,
    buildRenderPayload,
    buildSubmitCorrections,
  };
};
