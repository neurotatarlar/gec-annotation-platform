import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { CategorySummary } from "../types";

interface AssignmentResponse {
  text: { id: number; content: string };
}

type CategoryModalState = { mode: "create" } | { mode: "edit"; category: CategorySummary };

export type UploadEntry = { id?: string; text: string };

export const parseUploadJson = (value: string): UploadEntry[] => {
  if (!value || !value.trim()) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalidJson");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("invalidStructure");
  }
  const entries: UploadEntry[] = [];
  parsed.forEach((item, index) => {
    let text: string | null = null;
    let id: string | undefined;
    if (typeof item === "string") {
      text = item;
    } else if (item && typeof item === "object" && "text" in item) {
      text = typeof item.text === "string" ? item.text : String(item.text ?? "");
      if (item.id !== undefined && item.id !== null) {
        id = String(item.id);
      }
    } else {
      throw new Error(`invalidItem:${index}`);
    }
    if (!text || !text.trim()) return;
    entries.push({ id, text });
  });
  return entries;
};

export const mergeUploadEntries = (parts: UploadEntry[][]): UploadEntry[] => {
  const result: UploadEntry[] = [];
  const seen = new Set<string>();
  parts
    .flat()
    .filter(Boolean)
    .forEach((entry) => {
      const key = entry.id ?? `text:${entry.text}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push(entry);
    });
  return result;
};

export const CategoriesPage = () => {
  const api = useAuthedApi();
  const navigate = useNavigate();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [modalState, setModalState] = useState<CategoryModalState | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [uploadTarget, setUploadTarget] = useState<CategorySummary | null>(null);
  const [uploadText, setUploadText] = useState("");
  const [uploadFileContent, setUploadFileContent] = useState("");
  const [uploadFileName, setUploadFileName] = useState("");
  const [uploadFileIsM2, setUploadFileIsM2] = useState(false);
  const [uploadRequired, setUploadRequired] = useState(2);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const { data: categories, isLoading } = useQuery<CategorySummary[]>({
    queryKey: ["categories"],
    queryFn: async () => {
      const response = await api.get("/api/categories/");
      return response.data;
    }
  });
  const [emptyNotice, setEmptyNotice] = useState<CategorySummary | null>(null);

  const handleRequest = async (category: CategorySummary) => {
    try {
      const response = await api.post<AssignmentResponse>("/api/texts/assignments/next", null, {
        params: { category_id: category.id }
      });
      navigate(`/annotate/${response.data.text.id}`);
    } catch (err) {
      const detail = (err as any)?.response?.data?.detail;
      if ((err as any)?.response?.status === 404) {
        setEmptyNotice(category);
      } else {
        alert(detail ?? t("categories.noTexts"));
      }
    }
  };

  const isModalOpen = Boolean(modalState);
  const isEditing = modalState?.mode === "edit";

  useEffect(() => {
    if (!modalState) return;
    if (modalState.mode === "edit") {
      setFormName(modalState.category.name);
      setFormDescription(modalState.category.description ?? "");
    } else {
      setFormName("");
      setFormDescription("");
    }
    setFormError(null);
  }, [modalState]);

  useEffect(() => {
    if (uploadTarget) {
      setUploadText("");
      setUploadFileContent("");
      setUploadRequired(2);
      setUploadError(null);
    }
  }, [uploadTarget]);

  useEffect(() => {
    if (!uploadSuccess) return;
    const timer = window.setTimeout(() => setUploadSuccess(null), 5000);
    return () => window.clearTimeout(timer);
  }, [uploadSuccess]);


  const updateCategoryMutation = useMutation({
    mutationFn: async (payload: { id: number; name: string; description: string | null }) => {
      const response = await api.put(`/api/categories/${payload.id}`, {
        name: payload.name,
        description: payload.description
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      setModalState(null);
    },
    onError: (error: unknown) => {
      const detail = (error as any)?.response?.data?.detail;
      setFormError(detail ?? (error instanceof Error ? error.message : String(error)));
    }
  });

  const createCategoryMutation = useMutation({
    mutationFn: async (payload: { name: string; description: string | null }) => {
      const response = await api.post("/api/categories/", payload);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      setModalState(null);
    },
    onError: (error: unknown) => {
      const detail = (error as any)?.response?.data?.detail;
      setFormError(detail ?? (error instanceof Error ? error.message : String(error)));
    }
  });

  const uploadTextsMutation = useMutation({
    mutationFn: async (payload: { category_id: number; required_annotations: number; texts?: UploadEntry[]; m2_content?: string }) => {
      const response = await api.post("/api/texts/import", payload);
      return response.data as { inserted: number };
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      setUploadTarget(null);
      setUploadText("");
      setUploadFileContent("");
      setUploadFileName("");
      setUploadFileIsM2(false);
      setUploadError(null);
      setUploadSuccess(t("categories.uploadSuccess", { count: data.inserted }));
      setEmptyNotice((prev) => (prev && variables && prev.id === variables.category_id ? null : prev));
    },
    onError: (error: unknown) => {
      const detail = (error as any)?.response?.data?.detail;
      setUploadError(detail ?? (error instanceof Error ? error.message : String(error)));
    }
  });

  const toggleVisibilityMutation = useMutation({
    mutationFn: async (payload: { id: number; is_hidden: boolean }) => {
      const response = await api.put(`/api/categories/${payload.id}`, { is_hidden: payload.is_hidden });
      return response.data as CategorySummary;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  const handleModalSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!modalState) return;
    const trimmedName = formName.trim();
    if (!trimmedName) {
      setFormError(t("categories.editNameRequired"));
      return;
    }
    const trimmedDescription = formDescription.trim();
    if (modalState.mode === "edit") {
      updateCategoryMutation.mutate({
        id: modalState.category.id,
        name: trimmedName,
        description: trimmedDescription ? trimmedDescription : null
      });
    } else {
      createCategoryMutation.mutate({
        name: trimmedName,
        description: trimmedDescription ? trimmedDescription : null
      });
    }
  };

  const closeModal = () => {
    setModalState(null);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setUploadError(null);
    const file = event.target.files?.[0];
    if (!file) {
      setUploadFileContent("");
      setUploadFileName("");
      setUploadFileIsM2(false);
      return;
    }
    setUploadFileName(file.name);
    setUploadFileIsM2(file.name.toLowerCase().endsWith(".m2"));
    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const text = typeof loadEvent.target?.result === "string" ? loadEvent.target.result : "";
      setUploadFileContent(text);
    };
    reader.readAsText(file);
  };

  const handleUploadSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!uploadTarget) return;
    let entries: UploadEntry[] = [];
    try {
      const parts: UploadEntry[][] = [];
      if (uploadText.trim()) {
        parts.push(parseUploadJson(uploadText));
      }
      if (uploadFileContent.trim() && !uploadFileIsM2) {
        parts.push(parseUploadJson(uploadFileContent));
      }
      entries = mergeUploadEntries(parts);
    } catch (error: any) {
      const message = error?.message === "invalidStructure" ? "categories.uploadJsonStructure" : "categories.uploadJsonInvalid";
      setUploadError(t(message));
      return;
    }
    const payload: Record<string, unknown> = {
      category_id: uploadTarget.id,
      required_annotations: uploadRequired,
    };
    if (entries.length) {
      payload.texts = entries;
    }
    if (uploadFileContent.trim() && uploadFileIsM2) {
      payload.m2_content = uploadFileContent;
    }
    if ((!payload.texts || (Array.isArray(payload.texts) && (payload.texts as UploadEntry[]).length === 0)) && !payload.m2_content) {
      setUploadError(t("categories.uploadEmptyError"));
      return;
    }
    uploadTextsMutation.mutate(payload);
  };

  return (
    <div className="flex flex-col gap-6 text-right">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          className="rounded-lg border border-emerald-400/70 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.3)] transition hover:bg-emerald-500/40"
          onClick={() => setModalState({ mode: "create" })}
        >
          <span className="mr-2 text-lg font-bold">+</span>
          {t("categories.addButton")}
        </button>
      </div>
      {isLoading && <p>{t("common.loading")}</p>}
      {uploadSuccess && (
        <div className="rounded-2xl border border-emerald-400/40 bg-emerald-900/10 p-4 text-right text-sm text-emerald-50">
          <div className="flex items-center justify-between">
            <p>{uploadSuccess}</p>
            <button className="text-xs text-emerald-200" onClick={() => setUploadSuccess(null)}>
              ✕
            </button>
          </div>
        </div>
      )}
      {emptyNotice && (
        <div className="rounded-2xl border border-amber-400/40 bg-amber-900/20 p-4 text-right text-sm text-amber-100">
          <h2 className="text-base font-semibold text-amber-200">
            {t("categories.emptyTitle", { name: emptyNotice.name })}
          </h2>
          <p className="mt-2 text-amber-100/90">{t("categories.emptyBody")}</p>
          <div className="mt-3 flex justify-end gap-3 text-xs">
            <button
              className="rounded-lg border border-amber-300/70 px-3 py-1 text-amber-50"
              onClick={() => setEmptyNotice(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              className="rounded-lg border border-emerald-400/60 px-3 py-1 text-emerald-100"
              onClick={() => {
                setUploadTarget(emptyNotice);
                setEmptyNotice(null);
              }}
            >
              {t("categories.uploadButton")}
            </button>
          </div>
        </div>
      )}
      {(() => {
        const visible = (categories ?? []).filter((c) => !c.is_hidden);
        const hidden = (categories ?? []).filter((c) => c.is_hidden);
        const renderCard = (category: CategorySummary) => {
          const hasPendingTexts = category.remaining_texts > 0;

          return (
            <article
              key={category.id}
              role={hasPendingTexts ? "button" : undefined}
              tabIndex={hasPendingTexts ? 0 : -1}
              aria-disabled={!hasPendingTexts}
              onClick={hasPendingTexts ? () => handleRequest(category) : undefined}
              onKeyDown={
                hasPendingTexts
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleRequest(category);
                      }
                    }
                  : undefined
              }
              className={
                hasPendingTexts
                  ? "cursor-pointer rounded-2xl border border-slate-800 bg-slate-900/80 p-6 transition hover:border-emerald-400 hover:bg-slate-900/90 focus:outline focus:outline-2 focus:outline-emerald-400"
                  : "rounded-2xl border border-dashed border-slate-800/60 bg-slate-800/70 p-6 text-slate-400/90"
              }
            >
              <div className="flex items-start justify-between text-left">
                <div className="flex flex-col gap-2">
                  <h2 className="text-lg font-semibold">{category.name}</h2>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setModalState({ mode: "edit", category });
                    }}
                  >
                    {t("categories.editButton")}
                  </button>
                  <button
                    className="rounded-lg border border-emerald-500/60 px-3 py-1 text-xs text-emerald-100"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setUploadTarget(category);
                    }}
                  >
                    {t("categories.uploadButton")}
                  </button>
                  <button
                    className="rounded-lg border border-slate-600/70 px-3 py-1 text-xs text-slate-200"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleVisibilityMutation.mutate({ id: category.id, is_hidden: !category.is_hidden });
                    }}
                  >
                    {category.is_hidden ? t("categories.showCategory") : t("categories.hideCategory")}
                  </button>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-[0.7rem] text-slate-300 sm:text-xs">
                <span className="flex items-center gap-1 rounded-xl border border-slate-500/60 bg-slate-600/10 px-3 py-1 font-medium text-slate-100">
                  <span className="text-base font-semibold leading-none">{category.total_texts}</span>
                  <span>{t("categories.statTotal")}</span>
                </span>
                <span className="flex items-center gap-1 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 font-medium text-emerald-100">
                  <span className="text-base font-semibold leading-none">{category.remaining_texts}</span>
                  <span>{t("categories.statRemaining")}</span>
                </span>
                <span className="flex items-center gap-1 rounded-xl border border-sky-500/40 bg-sky-500/10 px-3 py-1 font-medium text-sky-100">
                  <span className="text-base font-semibold leading-none">{category.locked_texts}</span>
                  <span>{t("categories.statLocked")}</span>
                </span>
                <span className="flex items-center gap-1 rounded-xl border border-violet-500/30 bg-violet-500/5 px-3 py-1 font-medium text-violet-100/90">
                  <span className="text-base font-semibold leading-none">{category.skipped_texts}</span>
                  <span>{t("categories.statSkipped")}</span>
                </span>
                <span className="flex items-center gap-1 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-1 font-medium text-rose-100/90">
                  <span className="text-base font-semibold leading-none">{category.trashed_texts}</span>
                  <span>{t("categories.statTrash")}</span>
                </span>
              </div>
              {category.description && (
                <p className="mt-4 text-left text-sm leading-relaxed text-slate-300">{category.description}</p>
              )}
            </article>
          );
        };
        return (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visible.map(renderCard)}
              {!visible.length && <p className="text-sm text-slate-300">{t("categories.noVisible")}</p>}
            </div>
            {!!hidden.length && (
              <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-900/60 p-4">
                <button
                  type="button"
                  className="flex w-full items-center justify-between text-left text-slate-200"
                  onClick={() => setShowHidden((v) => !v)}
                >
                  <span className="font-semibold">{t("categories.hiddenGroup")}</span>
                  <span className="flex items-center gap-2 text-sm text-slate-300">
                    <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs">{hidden.length}</span>
                    <span>{showHidden ? "▴" : "▾"}</span>
                  </span>
                </button>
                {showHidden && (
                  <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {hidden.map(renderCard)}
                  </div>
                )}
              </div>
            )}
          </>
        );
      })()}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
          <form
            onSubmit={handleModalSubmit}
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-right shadow-2xl"
          >
            <h3 className="text-lg font-semibold text-slate-100">
              {isEditing ? t("categories.editTitle") : t("categories.createTitle")}
            </h3>
            <label className="mt-4 block text-right text-sm text-slate-300">
              <span>{t("categories.editNameLabel")}</span>
              <input
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/40 p-2 text-right text-slate-100 focus:border-emerald-400 focus:outline-none"
                value={formName}
                onChange={(event) => setFormName(event.target.value)}
                required
              />
            </label>
            <label className="mt-4 block text-right text-sm text-slate-300">
              <span>{t("categories.editDescriptionLabel")}</span>
              <textarea
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/40 p-2 text-right text-slate-100 focus:border-emerald-400 focus:outline-none"
                value={formDescription}
                rows={4}
                onChange={(event) => setFormDescription(event.target.value)}
              />
            </label>
            {formError && <p className="mt-3 text-sm text-rose-400">{formError}</p>}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200"
                onClick={closeModal}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                className="rounded-lg bg-emerald-500/80 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
                disabled={
                  (isEditing && updateCategoryMutation.isPending) ||
                  (!isEditing && createCategoryMutation.isPending)
                }
              >
                {isEditing
                  ? updateCategoryMutation.isPending
                    ? t("common.saving")
                    : t("common.save")
                  : createCategoryMutation.isPending
                    ? t("categories.creating")
                    : t("categories.createButton")}
              </button>
            </div>
          </form>
        </div>
      )}
      {uploadTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
          <form
            onSubmit={handleUploadSubmit}
            className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 p-6 text-right shadow-2xl"
          >
            <h3 className="text-lg font-semibold text-slate-100">
              {t("categories.uploadTitle", { name: uploadTarget.name })}
            </h3>
            <label className="mt-4 block text-right text-sm text-slate-300">
              <span>{t("categories.uploadTextareaLabel")}</span>
              <textarea
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/40 p-2 text-right text-slate-100 focus:border-emerald-400 focus:outline-none"
                rows={6}
                value={uploadText}
                placeholder={t("categories.uploadTextareaPlaceholder")}
                onChange={(event) => setUploadText(event.target.value)}
              />
            </label>
            <label className="mt-4 block text-right text-sm text-slate-300">
              <span>{t("categories.uploadFileLabel")}</span>
              <input
                type="file"
                accept=".json,.m2,application/json,text/json,text/plain"
                className="mt-1 w-full text-right text-xs text-slate-400"
                onChange={handleFileChange}
              />
              {uploadFileName && (
                <p className="mt-1 text-[11px] text-slate-500">
                  {uploadFileName} {uploadFileIsM2 ? "(M2)" : ""}
                </p>
              )}
            </label>
            <label className="mt-4 block text-right text-sm text-slate-300">
              <span>{t("categories.uploadRequiredLabel")}</span>
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/40 p-2 text-right text-slate-100 focus:border-emerald-400 focus:outline-none"
                value={uploadRequired}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setUploadRequired(Number.isFinite(next) && next > 0 ? next : 1);
                }}
              />
            </label>
            {uploadError && <p className="mt-3 text-sm text-rose-400">{uploadError}</p>}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200"
                onClick={() => setUploadTarget(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                className="rounded-lg bg-emerald-500/80 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
                disabled={uploadTextsMutation.isPending}
              >
                {uploadTextsMutation.isPending ? t("categories.uploading") : t("categories.uploadSubmit")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
