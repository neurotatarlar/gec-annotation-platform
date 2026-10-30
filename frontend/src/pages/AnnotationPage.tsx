/**
 * Page container for a single annotation task, wiring data loaders to the workspace.
 */
import { useQuery } from "@tanstack/react-query";
import React, { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { TokenEditor } from "../components/TokenEditor";
import { AnnotationReviewPanel } from "../components/AnnotationReviewPanel";
import { useI18n } from "../context/I18nContext";
import { useSaveStatus } from "../context/SaveStatusContext";
import { TextData } from "../types";

// Annotation page: loads the text by id and renders the TokenEditor with real content.
export const AnnotationPage: React.FC = () => {
  const { textId } = useParams();
  const api = useAuthedApi();
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const focusActionParam = searchParams.get("focusAction");
  const focusAction = focusActionParam === "skip" || focusActionParam === "trash" || focusActionParam === "submit" ? focusActionParam : undefined;
  const { data: profile, isLoading: profileLoading, isError: profileError } = useQuery<{ id: string; role?: string }>({
    queryKey: ["me"],
    queryFn: async () => {
      const response = await api.get("/api/auth/me");
      return response.data;
    },
  });

  const { data, isLoading, isError } = useQuery<TextData>({
    queryKey: ["text", textId],
    enabled: Boolean(textId),
    queryFn: async () => {
      const response = await api.get(`/api/texts/${textId}`);
      return response.data;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (!textId) {
    return <p className="p-6 text-slate-200">{t("annotation.textTitle", { id: "?" })}</p>;
  }

  if (isLoading || profileLoading) {
    return <p className="p-6 text-slate-200">{t("common.loading")}</p>;
  }

  if (isError || profileError || !data || !profile) {
    return <p className="p-6 text-rose-200">Failed to load text.</p>;
  }

  if ((profile.role === "admin" || profile.role === "manager") && searchParams.get("mode") !== "edit") {
    return <AnnotationReviewPanel key={data.id} textId={data.id} />;
  }

  return <>
    {(profile.role === "admin" || profile.role === "manager") && <button
      className="mb-3 self-start rounded-lg border border-slate-600 px-3 py-2 text-slate-100"
      onClick={() => { const params = new URLSearchParams(searchParams); params.delete("mode"); setSearchParams(params); }}>
      {t("annotationReview.viewAll")}
    </button>}
    <AnnotationScreen
      textId={data.id}
      categoryId={data.category_id}
      content={data.content}
      highlightAction={focusAction}
      currentUserId={profile.id}
    />
  </>;
};

export default AnnotationPage;

const AnnotationScreen = ({
  textId,
  categoryId,
  content,
  highlightAction,
  currentUserId,
}: {
  textId: number;
  categoryId: number;
  content: string;
  highlightAction?: "skip" | "trash" | "submit";
  currentUserId?: string;
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
        currentUserId={currentUserId}
        onSaveStatusChange={setStatus}
      />
    </div>
  );
};
