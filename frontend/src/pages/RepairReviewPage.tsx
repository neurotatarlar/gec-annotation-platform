/** Admin review queue for offline annotation repair proposals. */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuthedApi } from "../api/client";
import { useI18n } from "../context/I18nContext";

type RepairBatch = {
  id: string;
  revision: number;
  item_count: number;
  counts: { pending: number; approved: number; wrong: number };
};

type ProposedAnnotation = {
  id?: number;
  start_token: number;
  end_token: number;
  replacement?: string | null;
  error_type_id?: number | null;
  payload: {
    operation?: string;
    move_from?: number;
    move_to?: number;
    move_len?: number;
    client_correction_id?: string;
    label_needs_review?: boolean;
  };
};

type RepairItem = {
  id: number;
  batch_id: string;
  text_id: number;
  source: string;
  current_target: string;
  restored_target: string;
  proposed_target: string;
  recovery_evidence: {
    confidence?: "complete" | "uncertain" | "legacy";
    submitted_at?: string | null;
    post_submission_version_count?: number;
    excluded_after_submission_ids?: number[];
    possible_deleted_rows?: boolean;
    evidence_hash?: string;
    projection_mismatch?: boolean;
    backend_restored_target?: string | null;
    frontend_restored_target?: string | null;
  };
  uncertainty_acknowledged: boolean;
  candidate_hash: string;
  confidence: "high" | "medium" | "low";
  risk: string;
  explanation: string;
  status: "pending" | "approved" | "wrong";
  note?: string | null;
  proposal_revision: number;
  proposed_annotations: ProposedAnnotation[];
};

type ErrorType = { id: number; en_name?: string | null; tt_name?: string | null };

const tokenize = (text: string) => text.match(/\S+|\s+/g) ?? [];

const DiffText = ({ source, target }: { source: string; target: string }) => {
  const sourceParts = tokenize(source);
  const targetParts = tokenize(target);
  const changed = source !== target;
  if (!changed) return <span className="text-slate-200">{target}</span>;
  const sourceSet = new Set(sourceParts.filter((part) => part.trim()));
  return (
    <span>
      {targetParts.map((part, index) =>
        part.trim() && !sourceSet.has(part) ? (
          <mark key={`${part}-${index}`} className="bg-emerald-400/25 text-emerald-100">
            {part}
          </mark>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        )
      )}
    </span>
  );
};

export const RepairReviewPage = () => {
  const api = useAuthedApi();
  const queryClient = useQueryClient();
  const { locale } = useI18n();
  const [batchId, setBatchId] = useState("");
  const [status, setStatus] = useState<"pending" | "approved" | "wrong">("pending");
  const [confidence, setConfidence] = useState("");
  const [search, setSearch] = useState("");
  const [index, setIndex] = useState(0);
  const [wrongOpen, setWrongOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState<Record<string, string>>({});
  const [deferredItemIds, setDeferredItemIds] = useState<number[]>([]);
  const [uncertaintyAcknowledged, setUncertaintyAcknowledged] = useState(false);

  const batchesQuery = useQuery<RepairBatch[]>({
    queryKey: ["repair-batches"],
    queryFn: async () => (await api.get("/api/repairs/batches")).data
  });
  const batches = batchesQuery.data ?? [];
  useEffect(() => {
    if (!batchId && batches.length) setBatchId(batches[0].id);
  }, [batchId, batches]);
  const batch = batches.find((item) => item.id === batchId);

  const itemsQuery = useQuery<{ items: RepairItem[]; total: number }>({
    queryKey: ["repair-items", batchId, status, confidence, search],
    queryFn: async () =>
      (
        await api.get(`/api/repairs/batches/${batchId}/items`, {
          params: { status, confidence: confidence || undefined, query: search || undefined, limit: 1000 }
        })
      ).data,
    enabled: Boolean(batchId)
  });
  const fetchedItems = itemsQuery.data?.items ?? [];
  const items = useMemo(() => {
    const deferred = new Set(deferredItemIds);
    const byId = new Map(fetchedItems.map((candidate) => [candidate.id, candidate]));
    return [
      ...fetchedItems.filter((candidate) => !deferred.has(candidate.id)),
      ...deferredItemIds.flatMap((id) => {
        const candidate = byId.get(id);
        return candidate ? [candidate] : [];
      })
    ];
  }, [deferredItemIds, fetchedItems]);
  const safeIndex = Math.min(index, Math.max(0, items.length - 1));
  const item = items[safeIndex];
  useEffect(() => {
    setIndex(0);
    setDeferredItemIds([]);
  }, [batchId, status, confidence, search]);

  const errorTypesQuery = useQuery<ErrorType[]>({
    queryKey: ["error-types", "repair"],
    queryFn: async () => (await api.get("/api/error-types/")).data
  });
  const typeNames = useMemo(
    () =>
      new Map(
        (errorTypesQuery.data ?? []).map((type) => [
          type.id,
          (locale === "tt" ? type.tt_name : type.en_name) || type.en_name || type.tt_name || `#${type.id}`
        ])
      ),
    [errorTypesQuery.data, locale]
  );

  const correctionId = (annotation: ProposedAnnotation, index: number) =>
    annotation.payload.client_correction_id || `row-${index}`;

  useEffect(() => {
    if (!item) return;
    setTargetDraft(item.proposed_target);
    setEditingTarget(false);
    setUncertaintyAcknowledged(item.uncertainty_acknowledged);
    setLabelDraft(
      Object.fromEntries(
        item.proposed_annotations.map((annotation, rowIndex) => [
          correctionId(annotation, rowIndex),
          annotation.error_type_id == null ? "" : String(annotation.error_type_id)
        ])
      )
    );
  }, [item?.id, item?.candidate_hash]);

  const replaceCachedItem = (updated: RepairItem) => {
    queryClient.setQueryData<{ items: RepairItem[]; total: number }>(
      ["repair-items", batchId, status, confidence, search],
      (current) => current
        ? { ...current, items: current.items.map((candidate) => candidate.id === updated.id ? updated : candidate) }
        : current
    );
  };

  const proposal = useMutation({
    mutationFn: async (change: { proposed_target: string } | { labels: Record<string, number> } | { restore_revision: number }) => {
      if (!item) return null;
      const response = await api.patch(`/api/repairs/items/${item.id}/proposal`, {
        candidate_hash: item.candidate_hash,
        ...change
      });
      return response.data as RepairItem;
    },
    onSuccess: async (updated) => {
      if (updated) replaceCachedItem(updated);
      setError(null);
      setEditingTarget(false);
      await queryClient.invalidateQueries({ queryKey: ["repair-batches"] });
    },
    onError: (reason: any) => setError(reason?.response?.data?.detail ?? String(reason))
  });

  const labelsNeedConfirmation = Boolean(item?.proposed_annotations.some(
    (annotation) => annotation.error_type_id == null || annotation.payload.label_needs_review
  ));
  const labelsChanged = Boolean(item?.proposed_annotations.some((annotation, rowIndex) => {
    const value = labelDraft[correctionId(annotation, rowIndex)] || "";
    return value !== (annotation.error_type_id == null ? "" : String(annotation.error_type_id));
  }));

  const saveLabels = () => {
    if (!item) return;
    const labels = Object.fromEntries(
      item.proposed_annotations
        .map((annotation, rowIndex) => [
          correctionId(annotation, rowIndex),
          Number(labelDraft[correctionId(annotation, rowIndex)])
        ] as const)
        .filter((entry) => Number.isInteger(entry[1]) && entry[1] > 0)
    );
    proposal.mutate({ labels });
  };

  const skipForNow = () => {
    if (!item || items.length < 2) return;
    setDeferredItemIds((current) => [...current.filter((id) => id !== item.id), item.id]);
    setIndex(safeIndex >= items.length - 1 ? 0 : safeIndex);
  };

  const decision = useMutation({
    mutationFn: async ({ nextStatus, nextNote }: { nextStatus: RepairItem["status"]; nextNote?: string }) => {
      if (!item) return;
      const payload: Record<string, unknown> = {
        status: nextStatus,
        note: nextNote || null,
        candidate_hash: item.candidate_hash
      };
      if (item.recovery_evidence.possible_deleted_rows) {
        payload.uncertainty_acknowledged = uncertaintyAcknowledged;
      }
      await api.patch(`/api/repairs/items/${item.id}`, payload);
    },
    onSuccess: async () => {
      setError(null);
      setWrongOpen(false);
      setNote("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["repair-batches"] }),
        queryClient.invalidateQueries({ queryKey: ["repair-items"] })
      ]);
    },
    onError: (reason: any) => setError(reason?.response?.data?.detail ?? String(reason))
  });

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        wrongOpen || editingTarget || !item || decision.isPending || proposal.isPending ||
        target?.matches("input, textarea, select, [contenteditable='true']")
      ) return;
      if (event.key === "ArrowLeft") setIndex((value) => Math.max(0, value - 1));
      if (event.key === "ArrowRight") setIndex((value) => Math.min(items.length - 1, value + 1));
      if (
        event.key.toLowerCase() === "a"
        && !labelsNeedConfirmation
        && !labelsChanged
        && (!item.recovery_evidence.possible_deleted_rows || uncertaintyAcknowledged)
      ) decision.mutate({ nextStatus: "approved" });
      if (event.key.toLowerCase() === "w") setWrongOpen(true);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    decision,
    editingTarget,
    item,
    items.length,
    labelsChanged,
    labelsNeedConfirmation,
    proposal.isPending,
    uncertaintyAcknowledged,
    wrongOpen
  ]);

  const downloadArtifact = async (kind: "manifest" | "review-state") => {
    if (!batch) return;
    setError(null);
    try {
      const response = await api.get(`/api/repairs/batches/${batch.id}/${kind}`);
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `annotation-repair-${kind}-${batch.id.slice(0, 12)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason: any) {
      setError(reason?.response?.data?.detail ?? String(reason));
    }
  };

  return (
    <main className="mx-auto w-full max-w-[1500px] space-y-4 pb-10">
      <section className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Annotation repair review</h1>
          <p className="mt-1 text-sm text-slate-400">Category 3, latest submitted task per text</p>
        </div>
        {batch && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-slate-300">{batch.item_count} total</span>
            <span className="text-emerald-300">{batch.counts.approved} approved</span>
            <span className="text-amber-300">{batch.counts.pending} pending</span>
            <span className="text-rose-300">{batch.counts.wrong} wrong</span>
            <button
              type="button"
              onClick={() => downloadArtifact("review-state")}
              className="rounded-md border border-slate-700 px-3 py-2 font-semibold text-slate-200"
            >
              Download review state
            </button>
            <button
              type="button"
              disabled={batch.counts.pending > 0 || batch.counts.wrong > 0}
              onClick={() => downloadArtifact("manifest")}
              className="rounded-md bg-emerald-400 px-3 py-2 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Download manifest
            </button>
          </div>
        )}
      </section>

      <section className="grid gap-3 border-b border-slate-800 pb-4 md:grid-cols-[minmax(220px,1fr)_160px_160px_minmax(220px,1fr)]">
        <select value={batchId} onChange={(event) => setBatchId(event.target.value)} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100">
          {batches.map((candidate) => <option key={candidate.id} value={candidate.id}>Revision {candidate.revision} · {candidate.id.slice(0, 12)}</option>)}
        </select>
        <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100">
          <option value="pending">Pending</option><option value="approved">Approved</option><option value="wrong">Wrong</option>
        </select>
        <select value={confidence} onChange={(event) => setConfidence(event.target.value)} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100">
          <option value="">All confidence</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
        </select>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Text ID or source text" className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100" />
      </section>

      {error && <div className="rounded-md border border-rose-500/60 bg-rose-500/10 px-4 py-3 text-rose-100">{error}</div>}
      {!item && !itemsQuery.isLoading && <div className="py-16 text-center text-slate-400">No records match this filter.</div>}
      {item && (
        <>
          <section className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="flex items-center gap-3"><strong className="text-slate-100">Text {item.text_id}</strong><span className="text-slate-400">{safeIndex + 1} / {itemsQuery.data?.total ?? items.length}</span><span className="rounded border border-slate-700 px-2 py-1 text-slate-300">{item.confidence}</span><span className="text-slate-500">Proposal revision {item.proposal_revision}</span><span className="text-slate-500">{item.explanation}</span></div>
            <div className="flex gap-2"><button type="button" onClick={() => setIndex((value) => Math.max(0, value - 1))} disabled={safeIndex === 0} title="Previous" className="h-9 w-9 rounded-md border border-slate-700 text-slate-200 disabled:opacity-30">←</button><button type="button" onClick={() => setIndex((value) => Math.min(items.length - 1, value + 1))} disabled={safeIndex >= items.length - 1} title="Next" className="h-9 w-9 rounded-md border border-slate-700 text-slate-200 disabled:opacity-30">→</button></div>
          </section>

          <section aria-label="Repair text comparison" className="flex flex-col overflow-hidden rounded-md border border-slate-800">
            {[
              { label: "Source", value: item.source },
              { label: "Current stored-row projection", value: item.current_target },
              ...(item.recovery_evidence.projection_mismatch && item.recovery_evidence.backend_restored_target
                ? [{ label: "Backend submission stored-row projection", value: item.recovery_evidence.backend_restored_target }]
                : []),
              ...(item.recovery_evidence.projection_mismatch && item.recovery_evidence.frontend_restored_target
                ? [{ label: "Frontend submission stored-row projection", value: item.recovery_evidence.frontend_restored_target }]
                : []),
              { label: "Historically replayed submission render", value: item.restored_target }
            ].map((panel, panelIndex) => (
              <div key={panel.label} className={`min-h-[150px] p-5 ${panelIndex ? "border-t border-slate-800" : ""}`}>
                <h2 className="mb-3 text-xs font-semibold uppercase text-slate-500">{panel.label}</h2>
                <p className="whitespace-pre-wrap text-base leading-7 text-slate-200"><DiffText source={item.source} target={panel.value} /></p>
              </div>
            ))}
            <div
              className="min-h-[150px] border-t border-slate-800 p-5"
              onDoubleClick={() => !proposal.isPending && setEditingTarget(true)}
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-xs font-semibold uppercase text-slate-500">Proposed render</h2>
                {!editingTarget && (
                  <button type="button" onClick={() => setEditingTarget(true)} className="text-sm font-medium text-cyan-300">
                    Edit proposal
                  </button>
                )}
              </div>
              {editingTarget ? (
                <div className="space-y-3">
                  <textarea
                    autoFocus
                    aria-label="Proposed render"
                    value={targetDraft}
                    onChange={(event) => setTargetDraft(event.target.value)}
                    rows={10}
                    className="min-h-[180px] w-full resize-y rounded-md border border-cyan-500/70 bg-slate-950 p-3 text-base leading-7 text-slate-100"
                  />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => { setTargetDraft(item.proposed_target); setEditingTarget(false); }} className="rounded-md border border-slate-700 px-3 py-2 text-slate-200">Cancel</button>
                    <button type="button" disabled={targetDraft === item.proposed_target || proposal.isPending} onClick={() => proposal.mutate({ proposed_target: targetDraft })} className="rounded-md bg-cyan-400 px-3 py-2 font-semibold text-slate-950 disabled:opacity-40">Save proposal</button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-base leading-7 text-slate-200"><DiffText source={item.source} target={item.proposed_target} /></p>
              )}
            </div>
          </section>

          {item.recovery_evidence.possible_deleted_rows && (
            <section className="border-y border-amber-500/50 bg-amber-400/10 px-4 py-4 text-amber-100">
              <strong>Incomplete post-submission history</strong>
              <p className="mt-1 text-sm text-amber-200">
                This task has {item.recovery_evidence.post_submission_version_count ?? 0} later saved versions.
                {(item.recovery_evidence.excluded_after_submission_ids?.length ?? 0) > 0
                  ? ` ${item.recovery_evidence.excluded_after_submission_ids?.length} annotations created later were excluded.`
                  : " Rows deleted after submission cannot be ruled out."}
              </p>
              <label className="mt-3 flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={uncertaintyAcknowledged} onChange={(event) => setUncertaintyAcknowledged(event.target.checked)} />
                I reviewed the restored text with this uncertainty
              </label>
            </section>
          )}

          <section className="overflow-x-auto border-y border-slate-800 py-3">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Operation</th><th className="px-3 py-2">Source span</th><th className="px-3 py-2">Replacement</th><th className="px-3 py-2">Error label</th></tr></thead>
              <tbody>{item.proposed_annotations.map((annotation, rowIndex) => {
                const id = correctionId(annotation, rowIndex);
                const needsReview = annotation.error_type_id == null || annotation.payload.label_needs_review;
                return <tr key={id} className={`border-t border-slate-800 ${needsReview ? "bg-amber-400/10" : ""}`}><td className="px-3 py-2 text-slate-200">{annotation.payload.operation}</td><td className="px-3 py-2 font-mono text-slate-400">{annotation.start_token}–{annotation.end_token}</td><td className="px-3 py-2 text-slate-200">{annotation.replacement || "∅"}</td><td className="px-3 py-2"><select aria-label={`Error label for operation ${rowIndex + 1}`} value={labelDraft[id] || ""} onChange={(event) => setLabelDraft((current) => ({ ...current, [id]: event.target.value }))} className={`w-full min-w-48 rounded-md border bg-slate-950 px-2 py-2 text-slate-100 ${needsReview ? "border-amber-400" : "border-slate-700"}`}><option value="">Select label</option>{(errorTypesQuery.data ?? []).map((type) => <option key={type.id} value={type.id}>{typeNames.get(type.id)}</option>)}</select></td></tr>;
              })}</tbody>
            </table>
            {(labelsNeedConfirmation || labelsChanged) && <div className="flex items-center justify-end gap-3 px-3 pt-3"><span className="text-sm text-amber-300">Changed operations require confirmed labels.</span><button type="button" disabled={proposal.isPending || Object.values(labelDraft).some((value) => !value)} onClick={saveLabels} className="rounded-md bg-amber-300 px-4 py-2 font-semibold text-slate-950 disabled:opacity-40">Save labels</button></div>}
          </section>

          <section className="flex flex-wrap justify-between gap-3">
            <button type="button" onClick={() => proposal.mutate({ restore_revision: 1 })} disabled={item.proposal_revision === 1 || proposal.isPending} className="rounded-md border border-slate-700 px-4 py-3 text-slate-300 disabled:opacity-40">Reset generated</button>
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" onClick={skipForNow} disabled={items.length < 2 || decision.isPending || proposal.isPending || editingTarget} className="rounded-md border border-slate-600 px-5 py-3 font-semibold text-slate-200 disabled:opacity-40">Skip for now</button>
              <button type="button" onClick={() => { setNote(item.note || ""); setWrongOpen(true); }} disabled={decision.isPending || proposal.isPending || editingTarget} className="rounded-md border border-rose-500/60 px-5 py-3 font-semibold text-rose-100 disabled:opacity-40">Mark wrong</button>
              <button type="button" onClick={() => decision.mutate({ nextStatus: "approved" })} disabled={decision.isPending || proposal.isPending || editingTarget || labelsNeedConfirmation || labelsChanged || (item.recovery_evidence.possible_deleted_rows && !uncertaintyAcknowledged)} className="rounded-md bg-emerald-400 px-6 py-3 font-semibold text-slate-950 disabled:opacity-50">Approve</button>
            </div>
          </section>
        </>
      )}

      {wrongOpen && item && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-xl rounded-md border border-slate-700 bg-slate-950 p-6"><h2 className="text-lg font-semibold text-slate-100">What is wrong with text {item.text_id}?</h2><textarea autoFocus value={note} onChange={(event) => setNote(event.target.value)} rows={6} className="mt-4 w-full rounded-md border border-slate-700 bg-slate-900 p-3 text-slate-100" /><div className="mt-4 flex justify-end gap-3"><button type="button" onClick={() => setWrongOpen(false)} className="rounded-md border border-slate-700 px-4 py-2 text-slate-200">Cancel</button><button type="button" disabled={!note.trim() || decision.isPending} onClick={() => decision.mutate({ nextStatus: "wrong", nextNote: note.trim() })} className="rounded-md bg-rose-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-40">Save report</button></div></div></div>}
    </main>
  );
};
