import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { DashboardPage } from "./DashboardPage";

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" })
}));

const mockGet = vi.fn();
const activityCalls: any[] = [];
vi.mock("../api/client", () => ({
  useAuthedApi: () => ({
    get: mockGet
  })
}));

const observers: { instance: IntersectionObserver; callback: IntersectionObserverCallback }[] = [];

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push({ instance: this as unknown as IntersectionObserver, callback });
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

const setupMocks = () => {
  const now = new Date().toISOString();
  mockGet.mockImplementation((url: string, options?: any) => {
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
      const offset = options?.params?.offset ?? 0;
      const params = options?.params ?? {};
      activityCalls.push(params);

      if (offset === 0) {
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
            next_offset: 30
          }
        });
      }
      return Promise.resolve({
        data: {
          items: [
            {
              id: 31,
              kind: "task",
              text_id: 103,
              status: "submitted",
              occurred_at: now,
              text_preview: "page2",
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
    activityCalls.length = 0;
    observers.length = 0;
    localStorage.clear();
    // @ts-ignore
    global.IntersectionObserver = MockIntersectionObserver;
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

  it("sends filter parameters when searching and toggling types", async () => {
    renderPage();
    await screen.findByText("submitted text");

    const lastInitial = activityCalls[activityCalls.length - 1];
    expect(lastInitial?.kinds).toContain("task");

    const search = screen.getByPlaceholderText("dashboard.searchPlaceholder");
    fireEvent.change(search, { target: { value: "abc" } });
    await waitFor(() => {
      const last = activityCalls[activityCalls.length - 1];
      expect(last?.query).toBe("abc");
    });

    const submittedToggle = screen.getByText("dashboard.submittedTitle");
    fireEvent.click(submittedToggle);
    await waitFor(() => {
      const last = activityCalls[activityCalls.length - 1];
      expect(last?.kinds).toBe("skip,trash");
    });
  });

  it("auto-fetches next page when sentinel intersects", async () => {
    renderPage();
    await screen.findByText("submitted text");
    const initialCallCount = activityCalls.length;
    const observer = observers[observers.length - 1];
    observer.callback([{ isIntersecting: true, target: {} as Element, intersectionRatio: 1 }], observer.instance);
    await waitFor(() => expect(activityCalls.length).toBeGreaterThan(initialCallCount));
    expect(activityCalls[activityCalls.length - 1]?.offset).toBe(30);
    expect(await screen.findByText("page2")).toBeInTheDocument();
  });

  it("restores filters from localStorage", async () => {
    localStorage.setItem(
      "dashboardFilters",
      JSON.stringify({
        categories: [1],
        annotators: ["user-1"],
        search: "abc",
        showSkip: false,
        showTrash: true,
        showSubmitted: false,
        sortField: "category",
        sortOrder: "asc",
        dateFrom: "2024-01-01",
        dateTo: "2024-01-10"
      })
    );

    renderPage();
    await screen.findByDisplayValue("abc");

    // After filters hydrate, the next call should include them.
    await waitFor(() => {
      const last = activityCalls[activityCalls.length - 1];
      expect(last?.query).toBe("abc");
      expect(last?.category_ids).toBe("1");
      expect(last?.annotator_ids).toBe("user-1");
      expect(last?.kinds).toBe("trash"); // skip off, submitted off -> only trash
      expect(last?.sort).toBe("category");
      expect(last?.order).toBe("asc");
    });
  });

  it("keeps rows visible while kinds are toggled", async () => {
    renderPage();
    await screen.findByText("submitted text");

    fireEvent.click(screen.getByRole("button", { name: "dashboard.flaggedSkip" }));

    await waitFor(() => expect(activityCalls[activityCalls.length - 1]?.kinds).toBe("trash,task"));
    expect(screen.getByText("submitted text")).toBeInTheDocument();
    expect(screen.queryByText("common.loading")).not.toBeInTheDocument();
  });

  it("persists filters selected by the user", async () => {
    const view = renderPage();
    await screen.findByText("submitted text");

    fireEvent.click(screen.getByRole("button", { name: "Cat A" }));
    fireEvent.change(screen.getByPlaceholderText("dashboard.searchPlaceholder"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard.flaggedTrash" }));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("dashboardFilters") || "{}");
      expect(saved.categories).toEqual([1]);
      expect(saved.search).toBe("needle");
      expect(saved.showTrash).toBe(false);
    });

    view.unmount();
    activityCalls.length = 0;
    renderPage();
    await screen.findByDisplayValue("needle");

    await waitFor(() => {
      const last = activityCalls[activityCalls.length - 1];
      expect(last?.category_ids).toBe("1");
      expect(last?.query).toBe("needle");
      expect(last?.kinds).toBe("skip,task");
    });
  });

  it("skips fetch when all kinds toggled off", async () => {
    renderPage();
    await screen.findByText("submitted text");

    const skipBtn = screen.getAllByText("dashboard.flaggedSkip")[0];
    const trashBtn = screen.getAllByText("dashboard.flaggedTrash")[0];
    fireEvent.click(skipBtn);
    fireEvent.click(trashBtn);
    const beforeFinal = activityCalls.length;
    fireEvent.click(screen.getByText("dashboard.submittedTitle"));

    await waitFor(() => {
      expect(activityCalls.length).toBe(beforeFinal);
      expect(screen.getByText("dashboard.empty")).toBeInTheDocument();
    });
  });
});
