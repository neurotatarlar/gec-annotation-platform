import { useQuery } from "@tanstack/react-query";
import React, { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { TokenEditor } from "../components/TokenEditor";
import { useI18n } from "../context/I18nContext";
import { useSaveStatus } from "../context/SaveStatusContext";
import { TextData } from "../types";

// Annotation page: loads the text by id and renders the TokenEditor with real content.
export const AnnotationPage: React.FC = () => {
  const { textId } = useParams();
  const api = useAuthedApi();
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const focusActionParam = searchParams.get("focusAction");
  const focusAction = focusActionParam === "skip" || focusActionParam === "trash" || focusActionParam === "submit" ? focusActionParam : undefined;

  const { data, isLoading, isError } = useQuery<TextData>({
    queryKey: ["text", textId],
    enabled: Boolean(textId),
    queryFn: async () => {
      const response = await api.get(`/api/texts/${textId}`);
      return response.data;
    },
  });

  if (!textId) {
    return <p className="p-6 text-slate-200">{t("annotation.textTitle", { id: "?" })}</p>;
  }

  if (isLoading) {
    return <p className="p-6 text-slate-200">{t("common.loading")}</p>;
  }

  if (isError || !data) {
    return <p className="p-6 text-rose-200">Failed to load text.</p>;
  }

  return <AnnotationScreen textId={data.id} categoryId={data.category_id} content={data.content} highlightAction={focusAction} />;
};

export default AnnotationPage;

const AnnotationScreen = ({
  textId,
  categoryId,
  content,
  highlightAction,
}: {
  textId: number;
  categoryId: number;
  content: string;
  highlightAction?: "skip" | "trash" | "submit";
}) => {
  const { setStatus } = useSaveStatus();

  useEffect(() => {
    setStatus({ state: "idle", unsaved: false });
    return () => setStatus(null);
  }, [setStatus, textId]);

  return (
    <div className="flex flex-col gap-4">
      <TokenEditor
        initialText={content}
        textId={textId}
        categoryId={categoryId}
        highlightAction={highlightAction}
        onSaveStatusChange={setStatus}
      />
    </div>
  );
};
