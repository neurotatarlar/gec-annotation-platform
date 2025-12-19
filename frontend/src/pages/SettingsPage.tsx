import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { ErrorType } from "../types";

interface UserProfile {
  id: string;
  username: string;
  full_name?: string | null;
  role: string;
}

interface GlobalTypeDraft {
  description: string;
  default_color: string;
  default_hotkey: string;
  category_en?: string;
  category_tt?: string;
  en_name?: string;
  tt_name?: string;
  is_active: boolean;
  id?: number;
}

export const collectCategoryOptions = (
  errorTypes: ErrorType[],
  globalDrafts: Record<number, GlobalTypeDraft>,
  pendingNew: GlobalTypeDraft[],
  key: "category_en" | "category_tt"
) => {
  const set = new Set<string>();
  errorTypes.forEach((et) => {
    const val = et[key];
    if (val) set.add(val);
  });
  Object.values(globalDrafts).forEach((draft) => {
    const val = draft[key];
    if (val) set.add(val);
  });
  pendingNew.forEach((draft) => {
    const val = draft[key];
    if (val) set.add(val);
  });
  return Array.from(set).sort();
};

export const SettingsPage = () => {
  const api = useAuthedApi();
  const queryClient = useQueryClient();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [profileForm, setProfileForm] = useState({ username: "", password: "", passwordConfirm: "" });
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const { data: errorTypes = [] } = useQuery<ErrorType[]>({
    queryKey: ["error-types"],
    queryFn: async () => {
      const response = await api.get("/api/error-types/", { params: { include_inactive: true } });
      return response.data;
    }
  });

  const { data: profile } = useQuery<UserProfile>({
    queryKey: ["me"],
    queryFn: async () => {
      const response = await api.get("/api/auth/me");
      return response.data;
    }
  });

  const [globalDrafts, setGlobalDrafts] = useState<Record<number, GlobalTypeDraft>>({});
  const [pendingNew, setPendingNew] = useState<GlobalTypeDraft[]>([]);
  const [nextTempId] = useState(-1);
  const [showNewModal, setShowNewModal] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const formatError = (error: any) =>
    error?.response?.data?.detail ?? error?.message ?? t("settings.profileError");
  const createErrorTypeMutation = useMutation({
    mutationFn: async (payload: GlobalTypeDraft) => {
      const response = await api.post("/api/error-types/", {
        description: payload.description || null,
        default_color: payload.default_color || "#f97316",
        default_hotkey: payload.default_hotkey?.trim() || null,
        category_en: payload.category_en?.trim() || null,
        category_tt: payload.category_tt?.trim() || null,
        en_name: payload.en_name?.trim() || null,
        tt_name: payload.tt_name?.trim() || null,
        is_active: payload.is_active ?? true
      });
      return response.data;
    },
    onSuccess: () => {
      setSaveMessage(t("common.saved"));
      setSaveError(null);
      setShowNewModal(false);
      setNewType(buildEmptyNew());
      queryClient.invalidateQueries({ queryKey: ["error-types"] });
    },
    onError: (error: unknown) => {
      setSaveError(formatError(error));
    }
  });
  const presetColors = [
    "#f97316",
    "#0ea5e9",
    "#3b82f6",
    "#a855f7",
    "#14b8a6",
    "#ef4444",
    "#f59e0b",
    "#22c55e",
    "#eab308",
  ];
  const fields: (keyof GlobalTypeDraft)[] = [
    "description",
    "default_color",
    "default_hotkey",
    "category_en",
    "category_tt",
    "en_name",
    "tt_name",
    "is_active",
  ];
  const buildEmptyNew = React.useCallback(
    () => ({
      description: "",
      category_en: "",
      category_tt: "",
      en_name: "",
      tt_name: "",
      default_color: "#f97316",
      default_hotkey: "",
      is_active: true,
    }),
    []
  );
  const [newType, setNewType] = useState<GlobalTypeDraft>(() => buildEmptyNew());
  const closeNewModal = React.useCallback(() => {
    setShowNewModal(false);
    setNewType(buildEmptyNew());
  }, [buildEmptyNew]);

  useEffect(() => {
    if (!showNewModal) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNewModal();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [showNewModal, closeNewModal]);

  useEffect(() => {
    if (profile) {
      setProfileForm({
        username: profile.username,
        password: "",
        passwordConfirm: ""
      });
    }
  }, [profile]);

  useEffect(() => {
    const drafts: Record<number, GlobalTypeDraft> = {};
    errorTypes.forEach((type) => {
      drafts[type.id] = {
        description: type.description ?? "",
        default_color: type.default_color,
        default_hotkey: type.default_hotkey ?? "",
        category_en: type.category_en ?? "",
        category_tt: type.category_tt ?? "",
        en_name: type.en_name ?? "",
        tt_name: type.tt_name ?? "",
        is_active: type.is_active,
        id: type.id,
      };
    });
    setGlobalDrafts(drafts);
    setPendingNew([]);
    setSaveMessage(null);
    setSaveError(null);
  }, [errorTypes]);

  const profileMutation = useMutation({
    mutationFn: async (payload: { username: string; password?: string | null }) => {
      await api.put("/api/auth/me", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me"] });
      setProfileMessage(t("settings.profileSuccess"));
      setProfileError(null);
    },
    onError: (error: unknown) => {
      const detail = (error as any)?.response?.data?.detail;
      setProfileError(detail ?? t("settings.profileError"));
      setProfileMessage(null);
    }
  });

  const handleProfileSave = () => {
    const trimmedUsername = (profileForm.username ?? "").trim();
    const trimmedPassword = (profileForm.password ?? "").trim();
    const trimmedConfirm = (profileForm.passwordConfirm ?? "").trim();
    if (trimmedPassword !== trimmedConfirm) {
      setProfileError(t("settings.passwordMismatch"));
      return;
    }
    if (!trimmedUsername) {
      setProfileError(t("settings.profileUsernameRequired"));
      return;
    }
    profileMutation.mutate({
      username: trimmedUsername,
      password: trimmedPassword ? trimmedPassword : undefined
    });
    if (trimmedPassword) {
      setProfileForm((prev) => ({ ...prev, password: "", passwordConfirm: "" }));
    }
  };

  const updateGlobalDraft = (id: number, patch: Partial<GlobalTypeDraft>) => {
    setGlobalDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const updatePendingNew = (id: number, patch: Partial<GlobalTypeDraft>) => {
    setPendingNew((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const handleToggleStatus = (id: number) => {
    if (id > 0) {
      updateGlobalDraft(id, { is_active: !globalDrafts[id]?.is_active });
    } else {
      updatePendingNew(id, { is_active: !(pendingNew.find((p) => p.id === id)?.is_active ?? true) });
    }
  };

  const rows = useMemo(() => {
    const existing = errorTypes.map((type) => ({
      ...(globalDrafts[type.id] ?? {
        name: type.name,
        description: type.description ?? "",
        default_color: type.default_color,
        default_hotkey: type.default_hotkey ?? "",
        category_en: type.category_en ?? "",
        category_tt: type.category_tt ?? "",
        en_name: type.en_name ?? "",
        tt_name: type.tt_name ?? "",
        is_active: type.is_active,
      }),
      id: type.id,
    }));
    const normalizedNew = pendingNew.map((p) => ({
      description: p.description ?? "",
      default_color: p.default_color ?? "#f97316",
      default_hotkey: p.default_hotkey ?? "",
      category_en: p.category_en ?? "",
      category_tt: p.category_tt ?? "",
      en_name: p.en_name ?? "",
      tt_name: p.tt_name ?? "",
      is_active: p.is_active ?? true,
      id: p.id ?? nextTempId,
    }));
    const allRows = [...existing, ...normalizedNew];
    return allRows.sort((a, b) => {
      if (a.is_active === b.is_active) return 0;
      return a.is_active ? -1 : 1;
    });
  }, [errorTypes, globalDrafts, pendingNew, nextTempId]);

  const isTypeChanged = (orig: ErrorType, draft: GlobalTypeDraft | undefined) => {
    if (!draft) return false;
    return fields.some((field) => {
      const origVal = field === "is_active" ? orig.is_active : (orig as any)[field] ?? "";
      const draftVal = field === "is_active" ? draft.is_active : (draft as any)[field] ?? "";
      return origVal !== draftVal;
    });
  };

  const dirtyExisting = useMemo(
    () => errorTypes.some((type) => isTypeChanged(type, globalDrafts[type.id])),
    [errorTypes, globalDrafts]
  );
  const dirtyNew = pendingNew.length > 0;
  const isDirty = dirtyExisting || dirtyNew;

  const categoryTtOptions = useMemo(
    () => collectCategoryOptions(errorTypes, globalDrafts, pendingNew, "category_tt"),
    [errorTypes, globalDrafts, pendingNew]
  );

  const categoryEnOptions = useMemo(
    () => collectCategoryOptions(errorTypes, globalDrafts, pendingNew, "category_en"),
    [errorTypes, globalDrafts, pendingNew]
  );

  const handleSaveAll = async () => {
    if (!isDirty) return;
    setSavingAll(true);
    setSaveMessage(null);
    setSaveError(null);
    try {
      const changedExisting = errorTypes.filter((type) => isTypeChanged(type, globalDrafts[type.id]));
      const createPromises = pendingNew
        .filter((item) => (item.en_name ?? "").trim().length > 0 || (item.tt_name ?? "").trim().length > 0)
        .map((item) =>
          api.post("/api/error-types/", {
            description: item.description,
            default_color: item.default_color,
            default_hotkey: item.default_hotkey || null,
            category_en: item.category_en || null,
            category_tt: item.category_tt || null,
            en_name: item.en_name || null,
            tt_name: item.tt_name || null,
            is_active: item.is_active,
          })
        );
      const updatePromises = changedExisting.map((type) => {
        const draft = globalDrafts[type.id];
        if (!draft) return Promise.resolve();
        return api.put(`/api/error-types/${type.id}`, {
          description: draft.description,
          default_color: draft.default_color,
          default_hotkey: draft.default_hotkey || null,
          category_en: draft.category_en || null,
          category_tt: draft.category_tt || null,
          en_name: draft.en_name || null,
          tt_name: draft.tt_name || null,
          is_active: draft.is_active,
        });
      });
      await Promise.all([...createPromises, ...updatePromises]);
      setSaveMessage(t("common.saved"));
      setPendingNew([]);
      queryClient.invalidateQueries({ queryKey: ["error-types"] });
    } catch (error: any) {
      setSaveError(formatError(error));
    } finally {
      setSavingAll(false);
    }
  };

  const lastAnnotationPath =
    typeof window !== "undefined" ? window.localStorage.getItem("lastAnnotationPath") : null;
  const handleBack = () => {
    if (lastAnnotationPath) {
      navigate(lastAnnotationPath);
    } else {
      navigate("/");
    }
  };

  return (
    <div className="space-y-4 text-right">
      <div className="mb-2 flex items-center justify-between text-left">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">{t("settings.title")}</h1>
          <p className="text-sm text-slate-400">{t("settings.subtitle")}</p>
        </div>
        <button
          className="rounded-lg border border-slate-600 px-3 py-1 text-sm text-slate-100"
          onClick={handleBack}
        >
          {t("common.back")}
        </button>
      </div>
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
          <h2 className="text-lg font-semibold text-left text-slate-100">{t("settings.profileTitle")}</h2>
          <div className="mt-4 grid gap-4">
            <label className="text-left text-sm text-slate-300">
              {t("settings.profileUsername")}
              <input
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2"
                value={profileForm.username}
                maxLength={64}
                onChange={(event) => {
                  setProfileForm((prev) => ({ ...prev, username: event.target.value }));
                  setProfileMessage(null);
                  setProfileError(null);
                }}
              />
            </label>
            <label className="text-left text-sm text-slate-300">
              {t("settings.profilePassword")}
              <input
                type="password"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2"
                value={profileForm.password}
                placeholder={t("settings.profilePasswordPlaceholder")}
                maxLength={128}
                onChange={(event) => {
                  setProfileForm((prev) => ({ ...prev, password: event.target.value }));
                  setProfileMessage(null);
                  setProfileError(null);
                }}
              />
              <span className="text-xs text-slate-500">{t("settings.profilePasswordHint")}</span>
            </label>
            <label className="text-left text-sm text-slate-300">
              {t("settings.profilePasswordConfirm")}
              <input
                type="password"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2"
                value={profileForm.passwordConfirm}
                placeholder={t("settings.profilePasswordPlaceholder")}
                maxLength={128}
                onChange={(event) => {
                  setProfileForm((prev) => ({ ...prev, passwordConfirm: event.target.value }));
                  setProfileMessage(null);
                  setProfileError(null);
                }}
              />
            </label>
          </div>
          {profileMessage && <p className="mt-3 text-sm text-emerald-300">{profileMessage}</p>}
          {profileError && <p className="mt-3 text-sm text-rose-400">{profileError}</p>}
          <div className="mt-4 flex justify-end">
            <button
              className="rounded-lg border border-emerald-400/60 px-4 py-2 text-sm text-slate-100 disabled:opacity-50"
              onClick={handleProfileSave}
              disabled={
                profileMutation.isPending ||
                (profileForm.password ?? "").trim() !== (profileForm.passwordConfirm ?? "").trim()
              }
            >
              {profileMutation.isPending ? t("common.saving") : t("settings.profileSave")}
            </button>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-slate-900/70">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-left">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{t("settings.errorTypesHeader") ?? "Error categories"}</h2>
          </div>
          <div className="flex items-center gap-3">
            {saveMessage && <span className="text-xs text-emerald-300">{saveMessage}</span>}
            {saveError && <span className="text-xs text-rose-300">{saveError}</span>}
            <button
              className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-100"
              onClick={() => setShowNewModal(true)}
              title={t("settings.addButton")}
              aria-label={t("settings.addButton")}
            >
              {t("settings.addButton")}
            </button>
            <button
              className="rounded-lg border border-emerald-400/60 px-4 py-2 text-sm text-emerald-200 disabled:opacity-50"
              onClick={() => void handleSaveAll()}
              disabled={savingAll || !isDirty}
              title={savingAll ? t("common.saving") : t("common.save")}
              aria-label={savingAll ? t("common.saving") : t("common.save")}
            >
              {savingAll ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </div>
        <datalist id="category-tt-options">
          {categoryTtOptions.map((opt) => (
            <option key={opt} value={opt} />
          ))}
        </datalist>
        <datalist id="category-en-options">
          {categoryEnOptions.map((opt) => (
            <option key={opt} value={opt} />
          ))}
        </datalist>
        <table className="min-w-full border-collapse text-left text-sm text-slate-100">
          <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2">Category (TT)</th>
              <th className="px-3 py-2">Category (EN)</th>
              <th className="px-3 py-2">{t("settings.ttName")}</th>
              <th className="px-3 py-2">{t("settings.enNameLabel")}</th>
              <th className="px-3 py-2">{t("settings.hotkey")}</th>
              <th className="px-3 py-2">{t("settings.color")}</th>
              <th className="px-3 py-2">{t("settings.inactive")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const rowId = row.id ?? -(idx + 1);
              const isExisting = row.id !== undefined && row.id > 0;
              const onChangeField = (patch: Partial<GlobalTypeDraft>) => {
                if (isExisting && row.id) {
                  updateGlobalDraft(row.id, patch);
                } else {
                  updatePendingNew(rowId, patch);
                }
              };
              return (
                <React.Fragment key={rowId}>
                  <tr className={!row.is_active ? "bg-slate-900/40" : ""}>
                    <td className="px-3 py-2" colSpan={7}>
                      <span
                        className="inline-flex items-center self-start rounded-full px-2 py-1 text-xs font-semibold text-slate-900 shadow-sm"
                        style={{ backgroundColor: row.default_color }}
                      >
                        <span className="font-semibold">
                          {(locale ?? "").startsWith("tt") ? row.tt_name : row.en_name}{" "}
                          {(locale ?? "").startsWith("tt")
                            ? row.en_name
                              ? `(${row.en_name})`
                              : ""
                            : row.tt_name
                              ? `(${row.tt_name})`
                              : ""}
                        </span>
                        {row.default_hotkey && (
                          <span className="ml-2 rounded border border-slate-700 bg-slate-900/60 px-2 py-0.5 text-[11px] text-slate-100">
                            {row.default_hotkey}
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                  <tr className={!row.is_active ? "bg-slate-900/40" : ""}>
                    <td className="px-3 py-2 align-top">
                      <input
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-2 py-1"
                        value={row.category_tt}
                        list="category-tt-options"
                        onChange={(event) => onChangeField({ category_tt: event.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-2 py-1"
                        value={row.category_en}
                        list="category-en-options"
                        onChange={(event) => onChangeField({ category_en: event.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-2 py-1"
                        value={row.tt_name}
                        onChange={(event) => onChangeField({ tt_name: event.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-2 py-1"
                        value={row.en_name}
                        onChange={(event) => onChangeField({ en_name: event.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-2 py-1"
                        value={row.default_hotkey}
                        onChange={(event) => onChangeField({ default_hotkey: event.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                    <div className="flex flex-col gap-2">
                      <input
                        className="h-10 w-28 rounded-lg border border-slate-700 bg-slate-900/40 px-2 py-1"
                        type="color"
                        value={row.default_color}
                        onChange={(event) => onChangeField({ default_color: event.target.value })}
                      />
                      <div className="grid grid-cols-3 gap-2">
                        {presetColors.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className="h-6 w-6 rounded-full border border-slate-600 shadow-sm"
                            style={{ background: color }}
                            onClick={() => onChangeField({ default_color: color })}
                            aria-label={color}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-2 py-1"
                        value={row.default_hotkey}
                        onChange={(event) => onChangeField({ default_hotkey: event.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <button
                        className="rounded-lg border border-slate-600 px-3 py-1 text-xs"
                        onClick={() => handleToggleStatus(rowId)}
                      >
                        {row.is_active ? t("settings.deactivate") : t("settings.activate")}
                      </button>
                    </td>
                  </tr>
                  <tr className={!row.is_active ? "bg-slate-900/40" : ""}>
                    <td className="px-3 pb-3 text-xs text-slate-400 border-b-2 border-slate-500" colSpan={8}>
                      <textarea
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-2 py-2 text-sm text-slate-100"
                        value={row.description}
                        onChange={(event) => onChangeField({ description: event.target.value })}
                        rows={1}
                      />
                    </td>
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {showNewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-100">{t("settings.newType")}</h3>
              <button
                className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-100"
                onClick={closeNewModal}
              >
                {t("common.cancel")}
              </button>
            </div>
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <input
                  className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2"
                  placeholder={t("settings.descriptionPlaceholder")}
                  value={newType.description}
                  onChange={(event) => setNewType({ ...newType, description: event.target.value })}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <input
                  className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2"
                  placeholder="Category (TT)"
                  value={newType.category_tt}
                  list="category-tt-options"
                  onChange={(event) => setNewType({ ...newType, category_tt: event.target.value })}
                />
                <input
                  className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2"
                  placeholder="Category (EN)"
                  value={newType.category_en}
                  list="category-en-options"
                  onChange={(event) => setNewType({ ...newType, category_en: event.target.value })}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <input
                  className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2"
                  placeholder={t("settings.ttName")}
                  value={newType.tt_name}
                  onChange={(event) => setNewType({ ...newType, tt_name: event.target.value })}
                />
                <input
                  className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2"
                  placeholder={t("settings.enNameLabel")}
                  value={newType.en_name}
                  onChange={(event) => setNewType({ ...newType, en_name: event.target.value })}
                />
              </div>
              <div className="grid items-start gap-4 md:grid-cols-3">
                <div className="flex flex-col gap-2">
                  <input
                    type="color"
                    className="h-12 w-28 rounded-lg border border-slate-700 bg-slate-900/40"
                    value={newType.default_color}
                    onChange={(event) => setNewType({ ...newType, default_color: event.target.value })}
                  />
                  <div className="grid grid-cols-3 gap-2">
                    {presetColors.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className="h-7 w-7 rounded-full border border-slate-600 shadow-sm"
                        style={{ background: color }}
                        onClick={() => setNewType({ ...newType, default_color: color })}
                        aria-label={color}
                        title={color}
                      />
                    ))}
                  </div>
                </div>
                <input
                  className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2"
                  placeholder={t("settings.hotkey")}
                  value={newType.default_hotkey}
                  onChange={(event) => setNewType({ ...newType, default_hotkey: event.target.value })}
                />
                <div className="flex items-center gap-3">
                  <button
                    className="rounded-xl border border-emerald-400/60 px-4 py-2 text-sm text-emerald-200 disabled:opacity-50"
                    onClick={closeNewModal}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    className="rounded-xl bg-emerald-500/80 px-4 py-2 font-semibold text-slate-900 disabled:opacity-50"
                    onClick={() => {
                      if (!(newType.en_name?.trim() || newType.tt_name?.trim())) return;
                      createErrorTypeMutation.mutate(newType);
                    }}
                    disabled={
                      !(newType.en_name?.trim() || newType.tt_name?.trim()) || createErrorTypeMutation.isPending
                    }
                  >
                    {createErrorTypeMutation.isPending ? t("common.saving") : t("settings.add")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
