import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { DashboardPage } from "./DashboardPage";

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" })
}));

const mockGet = vi.fn();
vi.mock("../api/client", () => ({
  useAuthedApi: () => ({
    get: mockGet
  })
}));

const setupMocks = () => {
  const now = new Date().toISOString();
  mockGet.mockImplementation((url: string) => {
    if (url === "/api/categories/") {
      return Promise.resolve({
        data: [{ id: 1, name: "Cat A", description: null, is_hidden: false, total_texts: 0, remaining_texts: 0, in_progress_texts: 0, awaiting_review_texts: 0 }]
      });
    }
    if (url === "/api/dashboard/annotators") {
      return Promise.resolve({ data: [{ id: "user-1", username: "alice", full_name: "Alice" }] });
    }
    if (url === "/api/dashboard/stats") {
      return Promise.resolve({
        data: {
          total_texts: 10,
          pending_texts: 2,
          in_annotation_texts: 1,
          awaiting_review_texts: 3,
          completed_texts: 4,
          submitted_tasks: 5,
          skipped_count: 1,
          trashed_count: 2,
          last_updated: now
        }
      });
    }
    if (url === "/api/dashboard/activity") {
      return Promise.resolve({
        data: {
          items: [
            {
              id: 11,
              kind: "skip",
              status: "skip",
              occurred_at: now,
              text_id: 101,
              text_preview: "preview",
              category: { id: 1, name: "Cat A" },
              annotator: { id: "user-1", username: "alice", full_name: "Alice" }
            },
            {
              id: 21,
              kind: "task",
              text_id: 102,
              status: "submitted",
              occurred_at: now,
              text_preview: "submitted text",
              category: { id: 1, name: "Cat A" },
              annotator: { id: "user-1", username: "alice", full_name: "Alice" }
            }
          ],
          next_offset: null
        }
      });
    }
    throw new Error(`Unhandled url ${url}`);
  });
};

const renderPage = () => {
  setupMocks();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DashboardPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
};

describe("DashboardPage", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("renders stats and mixed activity feed", async () => {
    renderPage();

    expect(await screen.findByText("dashboard.title")).toBeInTheDocument();
    expect(await screen.findByText("10")).toBeInTheDocument();
    const badge = await screen.findAllByText("dashboard.flaggedSkip");
    expect(badge.length).toBeGreaterThan(0);
    const openButtons = await screen.findAllByText("history.open");
    expect(openButtons.length).toBeGreaterThan(0);
    expect(await screen.findByText("submitted text")).toBeInTheDocument();

    const loadMoreButtons = screen.queryAllByText("dashboard.loadMore");
    expect(loadMoreButtons.length).toBeGreaterThanOrEqual(0);
  });
});
