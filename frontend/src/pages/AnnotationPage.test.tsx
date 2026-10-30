import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AnnotationPage } from "./AnnotationPage";
import { SaveStatusProvider } from "../context/SaveStatusContext";

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

vi.mock("../api/client", () => ({
  useAuthedApi: () => ({
    get: mockGet,
    post: mockPost,
  }),
}));

const renderWithClient = (client: QueryClient, path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <SaveStatusProvider>
          <Routes>
            <Route path="/annotate/:textId" element={<AnnotationPage />} />
          </Routes>
        </SaveStatusProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );

describe("AnnotationPage", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ data: { id: "u1" } });
      if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
      if (url.includes("/api/texts/1/annotations")) return Promise.resolve({ data: [] });
      if (url === "/api/texts/1") {
        return Promise.resolve({ data: { id: 1, category_id: 1, content: "from-api" } });
      }
      return Promise.resolve({ data: {} });
    });
  });

  it("uses cached text data and skips fetching the text endpoint", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, cacheTime: 0 } },
    });
    client.setQueryData(["text", "1"], { id: 1, category_id: 1, content: "cached" });
    renderWithClient(client, "/annotate/1");

    await screen.findAllByRole("button", { name: "cached" });
    await waitFor(() => {
      const textCalls = mockGet.mock.calls.filter(([url]) => url === "/api/texts/1");
      expect(textCalls.length).toBe(0);
    });
  });

  it("fetches the text when cache is empty", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, cacheTime: 0 } },
    });
    renderWithClient(client, "/annotate/1");

    await screen.findByText("from-api");
    await waitFor(() => {
      const textCalls = mockGet.mock.calls.filter(([url]) => url === "/api/texts/1");
      expect(textCalls.length).toBe(1);
    });
  });
});

it("lets an admin review each author's corrections without mounting the editor or saving", async () => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === '/api/auth/me') return Promise.resolve({data:{id:'rinat-id',role:'admin'}});
    if (url === '/api/texts/1') return Promise.resolve({data:{id:1,category_id:3,content:'original'}});
    if (url === '/api/texts/1/annotation-review') return Promise.resolve({data:{text_id:1,source:'original',default_author_id:'rafida-id',authors:[
      {author_id:'rafida-id',username:'rafida',full_name:'Рәфидә',task_status:'submitted',target:'Rafida corrected',annotations:[{id:1,start_token:0,end_token:0,replacement:'Rafida corrected',error_type_name:'Spelling',payload:{operation:'replace',before_tokens:['base-0'],text_tokens:['original']}}]},
      {author_id:'rinat-id',username:'rinat',full_name:'Ринат',task_status:'submitted',target:'Rinat corrected',annotations:[]}
    ]}});
    return Promise.resolve({data:[]});
  });
  mockPost.mockClear();
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
  renderWithClient(client,'/annotate/1?focusAction=submit');
  await screen.findByText('Rafida corrected', {selector:'p'});
  expect(screen.getByText('Spelling')).toBeInTheDocument();
  const selector=screen.getByLabelText('annotationReview.author');
  const {fireEvent}=await import('@testing-library/react');
  fireEvent.change(selector,{target:{value:'rinat-id'}});
  await screen.findByText('Rinat corrected');
  expect(mockGet.mock.calls.some(([url])=>url==='/api/texts/1/annotations')).toBe(false);
  expect(mockPost).not.toHaveBeenCalled();
});
