import { useQuery } from "@tanstack/react-query";
import React, { useCallback, useState } from "react";
import { useParams } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { SaveStatus, TokenEditor } from "../components/TokenEditor";
import { useI18n } from "../context/I18nContext";
import { TextData } from "../types";

// Annotation page: loads the text by id and renders the TokenEditor with real content.
export const AnnotationPage: React.FC = () => {
  const { textId } = useParams();
  const api = useAuthedApi();
  const { t } = useI18n();

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

  return (
    <AnnotationScreen textId={data.id} categoryId={data.category_id} content={data.content} />
  );
};

export default AnnotationPage;

const AnnotationScreen = ({
  textId,
  categoryId,
  content,
}: {
  textId: number;
  categoryId: number;
  content: string;
}) => {
  const { t } = useI18n();
  const [status, setStatus] = useState<SaveStatus>({ state: "idle", unsaved: false });
  const handleStatusChange = useCallback((next: SaveStatus) => setStatus(next), []);

  const statusIcon = status.state === "saving" ? "⏳" : status.state === "saved" ? "✔" : status.state === "error" ? "⚠" : status.unsaved ? "●" : "○";
  const statusColor =
    status.state === "saving"
      ? "text-amber-300"
      : status.state === "saved"
        ? "text-emerald-300"
        : status.state === "error"
          ? "text-rose-300"
          : status.unsaved
            ? "text-amber-400"
            : "text-slate-400";
  const statusTitle =
    status.state === "saved"
      ? t("common.saved")
      : status.state === "saving"
        ? t("common.saving")
        : status.state === "error"
          ? t("common.error")
          : status.unsaved
            ? t("common.unsaved")
            : t("common.saved");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-full bg-slate-800/70 ${statusColor}`}
          title={statusTitle}
        >
          <span className="text-base leading-none">{statusIcon}</span>
        </div>
        <h1 className="text-xl font-semibold text-slate-100">{t("annotation.textTitle", { id: textId })}</h1>
      </div>
      <TokenEditor
        initialText={content}
        textId={textId}
        categoryId={categoryId}
        onSaveStatusChange={handleStatusChange}
      />
    </div>
  );
};
