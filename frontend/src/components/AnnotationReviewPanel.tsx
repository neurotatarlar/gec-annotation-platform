import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { buildTextFromTokens, buildTokensFromSnapshot } from "./TokenEditorModel";

type SavedAnnotation = {
  id: number;
  replacement: string | null;
  error_type_name: string;
  payload: { operation: string; before_tokens: string[]; text_tokens: string[] };
};
type AuthorSet = {
  author_id: string;
  username: string;
  full_name: string | null;
  task_status: string | null;
  target: string;
  annotations: SavedAnnotation[];
};
type Review = { text_id: number; source: string; default_author_id: string | null; authors: AuthorSet[] };

export const AnnotationReviewPanel = ({ textId }: { textId: number }) => {
  const api = useAuthedApi();
  const { t } = useI18n();
  const location = useLocation();
  const [authorId, setAuthorId] = useState<string | null>(null);
  const query = useQuery<Review>({
    queryKey: ["annotation-review", textId],
    queryFn: async () => (await api.get(`/api/texts/${textId}/annotation-review`)).data,
  });
  const editParams = new URLSearchParams(location.search);
  editParams.set("mode", "edit");
  const author = query.data?.authors.find(a => a.author_id === (authorId ?? query.data?.default_author_id))
    ?? query.data?.authors[0];
  const corrections = author?.annotations.filter(a => a.payload.operation !== "noop") ?? [];
  const beforeText = (ann: SavedAnnotation) => {
    if (ann.payload.operation === "insert") return "";
    const ids = new Set(ann.payload.before_tokens);
    return buildTextFromTokens(buildTokensFromSnapshot(ann.payload.text_tokens, query.data!.source)
      .filter(token => ids.has(token.id)));
  };

  return <section className="flex flex-col gap-5 rounded-2xl border border-slate-700 bg-slate-900 p-6 text-left text-slate-100">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{t("annotationReview.title")} #{textId}</h1>
        <p className="text-sm text-slate-400">{t("annotationReview.readOnly")}</p>
      </div>
      <Link className="rounded-lg border border-slate-600 px-3 py-2 text-sm" to={`${location.pathname}?${editParams}`}>
        {t("annotationReview.editMine")}
      </Link>
    </div>
    {query.isLoading ? <p>{t("common.loading")}</p> : query.isError ?
      <div role="alert"><p>{t("annotationReview.loadError")}</p><button onClick={() => query.refetch()}>{t("annotationReview.refresh")}</button></div> : <>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`review-author-${textId}`}>{t("annotationReview.author")}</label>
        <select id={`review-author-${textId}`} className="rounded-lg border border-slate-600 bg-slate-800 p-2"
          value={author?.author_id ?? ""} onChange={e => setAuthorId(e.target.value)}>
          {query.data?.authors.map(a => <option key={a.author_id} value={a.author_id}>
            {a.full_name || a.username} (@{a.username})
          </option>)}
        </select>
        {author?.task_status && <span className="text-sm text-slate-400">{author.task_status}</span>}
        <button className="rounded-lg border border-slate-600 px-3 py-2 text-sm" onClick={() => query.refetch()}>
          {t("annotationReview.refresh")}
        </button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-700 p-4"><h2 className="mb-3 font-semibold">{t("annotationReview.original")}</h2>
          <p className="whitespace-pre-wrap break-words leading-relaxed">{query.data?.source}</p></div>
        <div className="rounded-xl border border-emerald-800 p-4"><h2 className="mb-3 font-semibold">{t("annotationReview.corrected")}</h2>
          <p className="whitespace-pre-wrap break-words leading-relaxed">{author?.target ?? query.data?.source}</p></div>
      </div>
      <h2 className="font-semibold">{t("annotationReview.corrections")} ({corrections.length})</h2>
      {!corrections.length && <p className="text-slate-400">{t("annotationReview.empty")}</p>}
      <ol className="grid gap-3 md:grid-cols-2">{corrections.map((ann, index) => <li key={ann.id} className="rounded-xl border border-slate-700 p-4">
        <div className="mb-2 flex justify-between gap-2 text-sm"><span>#{index + 1} · {ann.payload.operation}</span>
          <span className="rounded bg-slate-800 px-2 py-1">{ann.error_type_name}</span></div>
        <del className="whitespace-pre-wrap break-words text-rose-300">{beforeText(ann) || "∅"}</del>
        <span aria-hidden="true"> → </span>
        <ins className="whitespace-pre-wrap break-words text-emerald-300 no-underline">{ann.replacement || "∅"}</ins>
      </li>)}</ol>
    </>}
  </section>;
};
