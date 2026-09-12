import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepairReviewPage } from "./RepairReviewPage";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

vi.mock("../api/client", () => ({ useAuthedApi: () => api }));
vi.mock("../context/I18nContext", () => ({ useI18n: () => ({ locale: "en" }) }));

const batch = {
  id: "batch-hash",
  revision: 1,
  item_count: 1,
  counts: { pending: 1, approved: 0, wrong: 0 }
};
const item = {
  id: 7,
  batch_id: batch.id,
  text_id: 520,
  source: "Alpha beta",
  current_target: "Alpha beta",
  restored_target: "Omega beta",
  proposed_target: "Omega beta",
  recovery_evidence: { confidence: "complete", possible_deleted_rows: false },
  uncertainty_acknowledged: false,
  candidate_hash: "candidate-hash",
  confidence: "high",
  risk: "legacy_ids",
  explanation: "legacy_ids",
  status: "pending",
  note: null,
  proposal_revision: 1,
  proposed_annotations: [
    {
      id: 12,
      start_token: 0,
      end_token: 0,
      replacement: "Omega",
      error_type_id: 3,
      payload: { operation: "replace", client_correction_id: "repair-12" }
    }
  ]
};

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RepairReviewPage />
    </QueryClientProvider>
  );
};

describe("RepairReviewPage", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.patch.mockReset();
    api.patch.mockResolvedValue({ data: { ...item, status: "approved" } });
    api.get.mockImplementation((url: string) => {
      if (url === "/api/repairs/batches") return Promise.resolve({ data: [batch] });
      if (url.includes("/api/repairs/batches/batch-hash/items")) {
        return Promise.resolve({ data: { items: [item], total: 1, next_offset: null } });
      }
      if (url === "/api/error-types/") {
        return Promise.resolve({ data: [{ id: 3, en_name: "Spelling" }] });
      }
      throw new Error(`Unhandled GET ${url}`);
    });
  });

  afterEach(cleanup);

  it("shows the comparison and records an approval against the candidate hash", async () => {
    renderPage();
    await screen.findByText("Text 520");
    expect(screen.getByRole("region", { name: "Repair text comparison" })).toHaveClass("flex-col");
    expect(screen.getAllByText("Omega").length).toBeGreaterThan(0);
    expect(screen.getByText("Spelling")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/repairs/items/7", {
        status: "approved",
        note: null,
        candidate_hash: "candidate-hash"
      })
    );
  });

  it("shows the audited punctuation-spacing change count", async () => {
    const normalizedItem = {
      ...item,
      recovery_evidence: {
        ...item.recovery_evidence,
        whitespace_normalization: {
          status: "applied",
          changes: [
            { rule: "separate_after_closing_punctuation", character_offset: 6, punctuation: "," }
          ],
          skipped: []
        }
      }
    };
    api.get.mockImplementation((url: string) => {
      if (url === "/api/repairs/batches") return Promise.resolve({ data: [batch] });
      if (url.includes("/api/repairs/batches/batch-hash/items")) {
        return Promise.resolve({ data: { items: [normalizedItem], total: 1, next_offset: null } });
      }
      if (url === "/api/error-types/") {
        return Promise.resolve({ data: [{ id: 3, en_name: "Spelling" }] });
      }
      throw new Error(`Unhandled GET ${url}`);
    });

    renderPage();
    await screen.findByText("Audited punctuation spacing");
    expect(screen.getByText(/1 token boundaries were normalized/)).toBeInTheDocument();
  });

  it("requires and sends a note for a wrong proposal", async () => {
    renderPage();
    await screen.findByText("Text 520");
    fireEvent.click(screen.getByRole("button", { name: "Mark wrong" }));
    const save = screen.getByRole("button", { name: "Save report" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getAllByRole("textbox")[1], { target: { value: "Move source is incorrect" } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/repairs/items/7", {
        status: "wrong",
        note: "Move source is incorrect",
        candidate_hash: "candidate-hash"
      })
    );
  });

  it("edits the proposed render in place with a candidate hash precondition", async () => {
    renderPage();
    await screen.findByText("Text 520");
    fireEvent.click(screen.getByRole("button", { name: "Edit proposal" }));
    const editor = screen.getByRole("textbox", { name: "Proposed render" });
    fireEvent.change(editor, { target: { value: "Gamma beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Save proposal" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/repairs/items/7/proposal", {
        candidate_hash: "candidate-hash",
        proposed_target: "Gamma beta"
      })
    );
  });

  it("blocks approval until a changed operation label is confirmed", async () => {
    const changedItem = {
      ...item,
      proposal_revision: 2,
      proposed_annotations: [{
        ...item.proposed_annotations[0],
        payload: {
          ...item.proposed_annotations[0].payload,
          label_needs_review: true
        }
      }]
    };
    api.get.mockImplementation((url: string) => {
      if (url === "/api/repairs/batches") return Promise.resolve({ data: [batch] });
      if (url.includes("/api/repairs/batches/batch-hash/items")) {
        return Promise.resolve({ data: { items: [changedItem], total: 1, next_offset: null } });
      }
      if (url === "/api/error-types/") {
        return Promise.resolve({ data: [{ id: 3, en_name: "Spelling" }] });
      }
      throw new Error(`Unhandled GET ${url}`);
    });

    renderPage();
    await screen.findByText("Text 520");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Error label for operation 1" }), {
      target: { value: "3" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save labels" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/repairs/items/7/proposal", {
        candidate_hash: "candidate-hash",
        labels: { "repair-12": 3 }
      })
    );
  });

  it("defers a skipped item to the end without changing backend state", async () => {
    const secondItem = {
      ...item,
      id: 8,
      text_id: 521,
      source: "Second source",
      current_target: "Second source",
      proposed_target: "Second proposal",
      candidate_hash: "second-candidate"
    };
    api.get.mockImplementation((url: string) => {
      if (url === "/api/repairs/batches") {
        return Promise.resolve({ data: [{ ...batch, item_count: 2, counts: { ...batch.counts, pending: 2 } }] });
      }
      if (url.includes("/api/repairs/batches/batch-hash/items")) {
        return Promise.resolve({ data: { items: [item, secondItem], total: 2, next_offset: null } });
      }
      if (url === "/api/error-types/") {
        return Promise.resolve({ data: [{ id: 3, en_name: "Spelling" }] });
      }
      throw new Error(`Unhandled GET ${url}`);
    });

    renderPage();
    await screen.findByText("Text 520");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await screen.findByText("Text 521");
    expect(api.patch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await screen.findByText("Text 520");
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("requires explicit acknowledgement for uncertain approval-time recovery", async () => {
    const uncertainItem = {
      ...item,
      recovery_evidence: {
        confidence: "uncertain",
        possible_deleted_rows: true,
        post_submission_version_count: 3,
        excluded_after_submission_ids: [99]
      }
    };
    api.get.mockImplementation((url: string) => {
      if (url === "/api/repairs/batches") return Promise.resolve({ data: [batch] });
      if (url.includes("/api/repairs/batches/batch-hash/items")) {
        return Promise.resolve({ data: { items: [uncertainItem], total: 1, next_offset: null } });
      }
      if (url === "/api/error-types/") {
        return Promise.resolve({ data: [{ id: 3, en_name: "Spelling" }] });
      }
      throw new Error(`Unhandled GET ${url}`);
    });

    renderPage();
    await screen.findByText("Incomplete post-submission history");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the restored text/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/repairs/items/7", {
        status: "approved",
        note: null,
        candidate_hash: "candidate-hash",
        uncertainty_acknowledged: true
      })
    );
  });
});
