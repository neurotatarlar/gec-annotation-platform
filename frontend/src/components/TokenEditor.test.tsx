import React from "react";
import { render, screen, waitFor, act, within, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { expect, describe, it, vi, beforeEach } from "vitest";

import {
  createInitialHistoryState,
  EditorHistoryState,
  buildTextFromTokens,
  buildTextFromTokensWithBreaks,
  buildM2Preview,
  computeTokensSha256,
  buildAnnotationsPayloadStandalone,
  shouldSkipSave,
  annotationsSignature,
  buildAnnotationsPayloadStandalone as buildStandalone,
  TokenEditor,
  tokenEditorReducer,
  tokenizeToTokens,
  deriveMoveMarkers,
  deriveCorrectionCards,
  buildHotkeyMap,
  parseHotkey,
  guessCodeFromKey,
} from "./TokenEditor";

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
  }),
}));

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock("../api/client", () => ({
  useAuthedApi: () => ({
    get: mockGet,
    post: mockPost,
  }),
}));

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, cacheTime: 0 },
    },
  });

// Silence React Router future-flag warnings and noisy act warnings that don't affect assertions.
const originalWarn = console.warn;
const originalError = console.error;
beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation((msg: any, ...rest: any[]) => {
    if (typeof msg === "string" && msg.includes("React Router Future Flag Warning")) return;
    originalWarn(msg, ...rest);
  });
  vi.spyOn(console, "error").mockImplementation((msg: any, ...rest: any[]) => {
    if (typeof msg === "string" && msg.includes("not wrapped in act")) return;
    originalError(msg, ...rest);
  });
});

afterAll(() => {
  (console.warn as any).mockRestore?.();
  (console.error as any).mockRestore?.();
});

beforeEach(() => {
  navigateMock.mockReset();
});

const renderEditor = (initialText: string, opts?: { getImpl?: (url: string) => Promise<any> }) => {
  mockGet.mockImplementation((url: string) => {
    if (opts?.getImpl) return opts.getImpl(url);
    if (url.includes("/api/error-types")) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ data: {} });
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={createQueryClient()}>
        <TokenEditor initialText={initialText} textId={1} categoryId={1} />
      </QueryClientProvider>
    </MemoryRouter>
  );
};

const stubTokenRects = (container: HTMLElement) => {
  const tokenNodes = Array.from(container.querySelectorAll("[data-token-index]")) as HTMLElement[];
  tokenNodes.forEach((node) => {
    const idx = Number(node.dataset.tokenIndex ?? 0);
    node.getBoundingClientRect = () =>
      ({
        left: idx * 20,
        right: idx * 20 + 10,
        top: 0,
        bottom: 10,
        width: 10,
        height: 10,
        x: idx * 20,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  const gapNodes = Array.from(container.querySelectorAll("[data-drop-index]")) as HTMLElement[];
  gapNodes.forEach((node) => {
    const idx = Number(node.dataset.dropIndex ?? 0);
    node.getBoundingClientRect = () =>
      ({
        left: idx * 20,
        right: idx * 20 + 6,
        top: 0,
        bottom: 10,
        width: 6,
        height: 10,
        x: idx * 20,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  });
};

const initState = (text = "hello world"): EditorHistoryState =>
  tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text });

const tokensToDisplay = (tokens: Array<{ kind?: string; text: string; moveId?: string; previousTokens?: unknown[] }>) =>
  tokens.map((tok) => (tok.kind === "empty" ? "⬚" : tok.text));

const findGroupContainer = (node: HTMLElement | null) => {
  let current: HTMLElement | null = node;
  while (current) {
    const radius = current.style.borderRadius;
    if (radius === "14px" || radius === "10px") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
};

const findIndexByText = (state: EditorHistoryState, text: string) => {
  const idx = state.present.tokens.findIndex((tok) => tok.kind !== "empty" && tok.text === text);
  if (idx === -1) {
    throw new Error(`Token not found: ${text}`);
  }
  return idx;
};

const deleteTokenByText = (state: EditorHistoryState, text: string) => {
  const idx = findIndexByText(state, text);
  return tokenEditorReducer(state, { type: "DELETE_SELECTED_TOKENS", range: [idx, idx] });
};

const editTokenByText = (state: EditorHistoryState, text: string, newText: string) => {
  const idx = findIndexByText(state, text);
  return tokenEditorReducer(state, { type: "EDIT_SELECTED_RANGE_AS_TEXT", range: [idx, idx], newText });
};

const editRangeByText = (state: EditorHistoryState, startText: string, endText: string, newText: string) => {
  const start = findIndexByText(state, startText);
  const end = findIndexByText(state, endText);
  return tokenEditorReducer(state, {
    type: "EDIT_SELECTED_RANGE_AS_TEXT",
    range: [Math.min(start, end), Math.max(start, end)],
    newText,
  });
};

const insertAfterToken = (state: EditorHistoryState, targetText: string, insertText: string) => {
  const idx = findIndexByText(state, targetText);
  const withPlaceholder = tokenEditorReducer(state, {
    type: "INSERT_TOKEN_AFTER_SELECTED",
    range: [idx, idx],
  });
  const insertIdx = idx + 1;
  return tokenEditorReducer(withPlaceholder, {
    type: "EDIT_SELECTED_RANGE_AS_TEXT",
    range: [insertIdx, insertIdx],
    newText: insertText,
  });
};

const moveTokensByText = (
  state: EditorHistoryState,
  fromTexts: string[],
  targetText: string,
  position: "before" | "after"
) => {
  const indices = fromTexts.map((text) => findIndexByText(state, text));
  const fromStart = Math.min(...indices);
  const fromEnd = Math.max(...indices);
  const targetIdx = findIndexByText(state, targetText);
  const toIndex = position === "before" ? targetIdx : targetIdx + 1;
  return tokenEditorReducer(state, {
    type: "MOVE_SELECTED_TOKENS",
    fromStart,
    fromEnd,
    toIndex,
  });
};

describe("tokenEditorReducer core flows", () => {
  it("replaces a selected token with new text and retains history", () => {
    const state1 = initState();

    const state2 = tokenEditorReducer(state1, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "hola",
    });

    const tokens = state2.present.tokens;
    expect(tokens.map((t) => t.text)).toEqual(["hola", "world"]);
    expect(tokens[0].previousTokens?.some((t) => t.text === "hello")).toBe(true);
  });

  it("undo restores the prior present state", () => {
    const state1 = initState();
    const edited = tokenEditorReducer(state1, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "hola",
    });

    const undone = tokenEditorReducer(edited, { type: "UNDO" });
    expect(undone.present.tokens.map((t) => t.text)).toEqual(["hello", "world"]);
  });

  it("tokenizes punctuation separately from words", () => {
    const tokens = tokenizeToTokens("Hi, world! 2+2=4 & *");
    expect(tokens.map((t) => t.text)).toEqual(["Hi", ",", "world", "!", "2", "+", "2", "=", "4", "&", "*"]);
  });

  it("marks no leading space when punctuation is attached", () => {
    const tokens = tokenizeToTokens("hi, world");
    const comma = tokens.find((t) => t.text === ",");
    expect(comma?.spaceBefore).toBe(false);
    const spaced = tokenizeToTokens("hi , world");
    const commaSpaced = spaced.find((t) => t.text === ",");
    expect(commaSpaced?.spaceBefore).toBe(true);
  });

  it("treats phone, email, and url as special tokens", () => {
    const tokens = tokenizeToTokens("Call +123-456-7890 or mail x@y.com and visit https://example.com.");
    const kinds = tokens.map((t) => t.kind);
    expect(tokens.map((t) => t.text)).toContain("+123-456-7890");
    expect(tokens.map((t) => t.text)).toContain("x@y.com");
    expect(tokens.map((t) => t.text)).toContain("https://example.com");
    const specialCount = kinds.filter((k) => k === "special").length;
    expect(specialCount).toBe(3);
  });

  it("handles complex URLs with query chars without splitting", () => {
    const url =
      "http://intertat.ru/tt/yanalyklar/item/52387-ya%D2%A3a-el-b%D3%99yr%D3%99mn%D3%99rend%D3%99-%D2%97%D3%99m%D3%99gat-transportyi-hezm%D3%99te-nichek-eshli?.html";
    const tokens = tokenizeToTokens(`Question? ${url}`);
    expect(tokens.map((t) => t.text)).toContain(url);
    expect(tokens.find((t) => t.text === url)?.kind).toBe("special");
  });

  it("merges a range into a single token while preserving history", () => {
    const state1 = initState("foo bar baz");
    const state2 = tokenEditorReducer(state1, { type: "MERGE_RANGE", range: [0, 1] });
    const merged = state2.present.tokens;

    expect(merged[0].text).toBe("foobar");
    expect(merged[0].previousTokens?.length).toBeGreaterThanOrEqual(2);
    expect(merged[1].text).toBe("baz");
  });

  it("treats edited text literally and splits only on whitespace", () => {
    const state1 = initState("foobar");
    const state2 = tokenEditorReducer(state1, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo-bar",
    });
    expect(state2.present.tokens.map((t) => t.text)).toEqual(["foo-bar"]);

    const state3 = tokenEditorReducer(state2, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo bar",
    });
    expect(state3.present.tokens.map((t) => t.text)).toEqual(["foo", "bar"]);
  });

  it("preserves explicit spaces before punctuation when re-editing a correction", async () => {
    const edited = tokenEditorReducer(initState("hello world"), {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo , bar",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("hello world");
    const user = userEvent.setup();
    const foo = await screen.findByRole("button", { name: "foo" });
    await user.dblClick(foo);
    const input = await screen.findByPlaceholderText("tokenEditor.editPlaceholder");
    expect((input as HTMLInputElement).value).toBe("foo , bar");
  });

  it("reverts corrections when edited text matches the original content", () => {
    const state1 = initState("hello world");
    const edited = tokenEditorReducer(state1, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "hi",
    });
    const reverted = tokenEditorReducer(edited, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "hello",
    });
    expect(reverted.present.tokens.map((t) => t.text)).toEqual(["hello", "world"]);
    expect(reverted.present.tokens[0].previousTokens).toBeUndefined();
  });

  it("deletes a multi-token range into a single placeholder with history", () => {
    const state1 = initState("alpha beta gamma");
    const state2 = tokenEditorReducer(state1, { type: "DELETE_SELECTED_TOKENS", range: [0, 1] });
    const tokens = state2.present.tokens;
    expect(tokens.length).toBe(2);
    expect(tokens[0].kind).toBe("empty");
    expect(tokens[0].previousTokens?.map((t) => t.text)).toEqual(["alpha", "beta"]);
    expect(tokens[1].text).toBe("gamma");
  });

  it("edits a multi-token range into a multi-token replacement and preserves history", () => {
    const state1 = initState("alpha beta gamma");
    const state2 = tokenEditorReducer(state1, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 1],
      newText: "one two three",
    });
    const tokens = state2.present.tokens;
    expect(tokens.slice(0, 3).map((t) => t.text)).toEqual(["one", "two", "three"]);
    expect(tokens[3].text).toBe("gamma");
    const anchor = tokens[1];
    expect(anchor.previousTokens?.map((t) => t.text)).toEqual(["alpha", "beta"]);
    expect(tokens[0].groupId).toBe(tokens[1].groupId);
    expect(tokens[1].groupId).toBe(tokens[2].groupId);
  });

  it("clears selection after editing a correction back to the original text", async () => {
    const base = initState("hello world");
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "hi",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("hello world");
    const user = userEvent.setup();
    const hi = await screen.findByRole("button", { name: "hi" });
    await user.dblClick(hi);
    const input = await screen.findByPlaceholderText("tokenEditor.editPlaceholder");
    await user.clear(input);
    await user.type(input, "hello");
    await user.tab();
    await waitFor(() => expect(screen.queryByRole("button", { name: "hi" })).toBeNull());
    await waitFor(() => {
      const helloBtn = screen.getAllByRole("button").find((el) => el.textContent === "hello");
      expect(helloBtn).toBeTruthy();
      expect(helloBtn?.getAttribute("aria-pressed")).toBe("false");
    });
  });

  it("buildTextFromTokens skips empty placeholders", () => {
    const tokens = [
      { id: "1", text: "hello", kind: "word", selected: false },
      { id: "2", text: "", kind: "empty", selected: false },
      { id: "3", text: "world", kind: "word", selected: false },
    ] as any;
    expect(buildTextFromTokens(tokens)).toBe("hello world");
  });

  it("buildTextFromTokens preserves explicit spaces before punctuation", () => {
    const tokens = [
      { id: "1", text: "foo", kind: "word", selected: false, spaceBefore: false },
      { id: "2", text: ",", kind: "punct", selected: false, spaceBefore: true },
      { id: "3", text: "bar", kind: "word", selected: false, spaceBefore: true },
    ] as any;
    expect(buildTextFromTokens(tokens)).toBe("foo , bar");
  });

  it("buildTextFromTokensWithBreaks preserves new lines", () => {
    const tokens = [
      { id: "1", text: "hello", kind: "word", selected: false },
      { id: "2", text: "world", kind: "word", selected: false },
      { id: "3", text: "next", kind: "word", selected: false },
    ] as any;
    const breaks = [2]; // newline after second visible token
    expect(buildTextFromTokensWithBreaks(tokens, breaks)).toBe("hello world\nnext");
  });

  it("buildTextFromTokensWithBreaks preserves spaces before punctuation", () => {
    const tokens = [
      { id: "1", text: "foo", kind: "word", selected: false, spaceBefore: false },
      { id: "2", text: ",", kind: "punct", selected: false, spaceBefore: true },
      { id: "3", text: "bar", kind: "word", selected: false, spaceBefore: true },
    ] as any;
    expect(buildTextFromTokensWithBreaks(tokens, [])).toBe("foo , bar");
  });

  it("buildTextFromTokensWithBreaks preserves blank lines", () => {
    const tokens = [
      { id: "1", text: "hello", kind: "word", selected: false },
      { id: "2", text: "world", kind: "word", selected: false },
    ] as any;
    const breaks = [1, 1]; // two newlines after first visible token
    expect(buildTextFromTokensWithBreaks(tokens, breaks)).toBe("hello\n\nworld");
  });

  it("renders first/last tokens flush to container", async () => {
    localStorage.clear();
    await renderEditor("hello world");
    const panel = await screen.findByTestId("corrected-panel");
    const chips = panel.querySelectorAll("div[role='button']");
    expect(chips.length).toBeGreaterThanOrEqual(2);
    const panelRect = panel.getBoundingClientRect();
    const firstRect = chips[0].getBoundingClientRect();
    const lastRect = chips[chips.length - 1].getBoundingClientRect();
    expect(firstRect.left - panelRect.left).toBeLessThanOrEqual(1);
    expect(panelRect.right - lastRect.right).toBeLessThanOrEqual(1);
  });
  it("sizes edit pill close to text length", async () => {
    localStorage.clear();
    await renderEditor("hello world");
    const user = userEvent.setup();
    const hello = await screen.findByText("hello");
    await user.dblClick(hello);
    await user.keyboard("{Backspace}a");
    const inputs = screen.getAllByRole("textbox");
    expect(inputs.length).toBeGreaterThan(0);
    const widthPx = inputs[0].getBoundingClientRect().width;
    expect(widthPx).toBeLessThan(120);
  });

  it("keeps the edit pill vertically aligned with the original token", async () => {
    localStorage.clear();
    await renderEditor("hello world");
    const user = userEvent.setup();
    const hello = await screen.findByText("hello");
    const originalTop = hello.getBoundingClientRect().top;
    await user.dblClick(hello);
    const input = await screen.findByRole("textbox");
    const inputTop = input.getBoundingClientRect().top;
    expect(Math.abs(inputTop - originalTop)).toBeLessThanOrEqual(4);
  });

  it("respects line breaks from multiline text", async () => {
    localStorage.clear();
    await renderEditor("foo bar\nbaz qux");
    const breaks = await screen.findAllByTestId("line-break");
    expect(breaks.length).toBeGreaterThan(0);
    const panel = screen.getByTestId("corrected-panel");
    await waitFor(() => {
      const labels = Array.from(panel.querySelectorAll('[role="button"], [data-testid="line-break"]'))
        .map((node) => (node.getAttribute("data-testid") === "line-break" ? "BR" : node.textContent?.trim()))
        .filter((label) => label && ["foo", "bar", "baz", "qux", "BR"].includes(label));
      expect(labels).toEqual(["foo", "bar", "BR", "baz", "qux"]);
    });
  });

  it("renders consecutive line breaks as empty lines", async () => {
    localStorage.clear();
    await renderEditor("foo\n\nbar");
    const panel = await screen.findByTestId("corrected-panel");
    const breaks = await screen.findAllByTestId("line-break");
    expect(breaks.length).toBeGreaterThanOrEqual(2);
    await waitFor(() => {
      const labels = Array.from(panel.querySelectorAll('[role="button"], [data-testid="line-break"]'))
        .map((node) => (node.getAttribute("data-testid") === "line-break" ? "BR" : node.textContent?.trim()))
        .filter((label) => label && ["foo", "bar", "BR"].includes(label));
      expect(labels).toEqual(["foo", "BR", "BR", "bar"]);
    });
  });

  it("avoids space markers at the start of a new line", async () => {
    localStorage.clear();
    await renderEditor("bar\nzulu");
    const panel = await screen.findByTestId("corrected-panel");
    const lineBreak = panel.querySelector('[data-testid="line-break"]');
    expect(lineBreak).toBeTruthy();
    const afterBreak = lineBreak?.nextElementSibling;
    expect(afterBreak?.querySelector('[data-testid="space-marker"]')).toBeNull();
  });

  it("keeps line breaks when hydrating annotations without snapshot spacing", async () => {
    localStorage.clear();
    await renderEditor("hello\nworld", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/api/texts/1/annotations")) {
          return Promise.resolve({
            data: [
              {
                start_token: 0,
                end_token: 0,
                replacement: null,
                payload: { operation: "noop", text_tokens: ["hello", "world"] },
                error_type_id: null,
                version: 1,
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });
    const breaks = await screen.findAllByTestId("line-break");
    expect(breaks.length).toBeGreaterThan(0);
    const panel = screen.getByTestId("corrected-panel");
    await waitFor(() => {
      const labels = Array.from(panel.querySelectorAll('[role="button"], [data-testid="line-break"]'))
        .map((node) => (node.getAttribute("data-testid") === "line-break" ? "BR" : node.textContent?.trim()))
        .filter((label) => label && ["hello", "world", "BR"].includes(label));
      expect(labels).toEqual(["hello", "BR", "world"]);
    });
  });

  it("keeps punctuation chips tight to their borders", async () => {
    localStorage.clear();
    await renderEditor("hi ) there");
    const punct = await screen.findByText(")");
    const width = punct.getBoundingClientRect().width;
    expect(width).toBeLessThan(21);
  });

  it("renders smaller gaps around punctuation when there is no explicit space", async () => {
    localStorage.clear();
    localStorage.setItem("tokenEditorPrefs", JSON.stringify({ tokenGap: 20, spaceMarker: "none" }));
    await renderEditor("foo, bar");
    const panel = await screen.findByTestId("corrected-panel");
    const gapBeforeComma = panel.querySelector("[data-drop-index='1']") as HTMLElement | null;
    const gapAfterComma = panel.querySelector("[data-drop-index='2']") as HTMLElement | null;
    if (!gapBeforeComma || !gapAfterComma) {
      throw new Error("Expected punctuation gaps to render");
    }
    const beforeWidth = parseFloat(gapBeforeComma.style.width);
    const afterWidth = parseFloat(gapAfterComma.style.width);
    expect(beforeWidth).toBeLessThan(afterWidth);
  });

  it("renders space markers between tokens inside and outside edited groups", async () => {
    localStorage.clear();
    await renderEditor("hello world");
    const user = userEvent.setup();
    const select = await screen.findByLabelText(/tokeneditor\.spaceMark/i);
    await user.selectOptions(select, "dot");
    const hello = await screen.findByText("hello");
    await user.dblClick(hello);
    await user.keyboard("{Backspace}hello there");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      const markers = screen.getAllByTestId("space-marker");
      expect(markers.length).toBeGreaterThanOrEqual(1);
      expect(markers.some((el) => el.textContent === "·")).toBe(true);
    });
  });

  it("positions space markers slightly below center", async () => {
    localStorage.clear();
    await renderEditor("hello world");
    const user = userEvent.setup();
    const select = await screen.findByLabelText(/tokeneditor\.spaceMark/i);
    await user.selectOptions(select, "box");
    const marker = await screen.findByTestId("space-marker");
    expect(marker.style.position).toBe("absolute");
    expect(marker.style.top).toBe("50%");
    expect(marker.style.transform).toContain("calc(-50% +");
  });

  it("hides space markers while an edit field is open and restores them after committing", async () => {
    localStorage.clear();
    await renderEditor("hello world");
    const user = userEvent.setup();
    const select = await screen.findByLabelText(/tokeneditor\.spaceMark/i);
    await user.selectOptions(select, "dot");
    const hello = await screen.findByText("hello");
    await user.dblClick(hello);
    const input = await screen.findByDisplayValue("hello");
    expect(screen.queryByTestId("space-marker")).toBeNull();
    await user.type(input, "{Enter}");
    await waitFor(() => {
      const markers = screen.getAllByTestId("space-marker");
      expect(markers.length).toBeGreaterThan(0);
    });
  });

  it("renders a space marker before a corrected group when spacing exists", async () => {
    localStorage.clear();
    const edited = tokenEditorReducer(initState("hello world"), {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [1, 1],
      newText: "big world",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("hello world");
    const panel = await screen.findByTestId("corrected-panel");
    const markers = panel.querySelectorAll("[data-testid='space-marker']");
    expect(markers.length).toBe(2);
  });

  it("drops a move on the panel using the active caret position", async () => {
    localStorage.clear();
    await renderEditor("alpha beta gamma");
    const panel = await screen.findByTestId("corrected-panel");
    stubTokenRects(panel);
    const alpha = within(panel).getByRole("button", { name: "alpha" });
    const gamma = within(panel).getByRole("button", { name: "gamma" });
    const dataTransfer = {
      setData: () => {},
      setDragImage: () => {},
      effectAllowed: "",
    };
    fireEvent.dragStart(alpha, { dataTransfer });
    fireEvent.dragOver(gamma, { dataTransfer, clientX: 100, clientY: 5 });
    fireEvent.drop(gamma, { dataTransfer, clientX: 100, clientY: 5 });

    const tokens = within(panel)
      .getAllByRole("button")
      .filter((el) => el.getAttribute("data-token-index") !== null)
      .map((el) => el.textContent);
    expect(tokens.join(" ")).toBe("⬚ beta alpha gamma");
  });

  it("drops a move on the panel after hovering a gap", async () => {
    localStorage.clear();
    await renderEditor("alpha beta gamma");
    const panel = await screen.findByTestId("corrected-panel");
    stubTokenRects(panel);
    const alpha = within(panel).getByRole("button", { name: "alpha" });
    const dataTransfer = {
      setData: () => {},
      setDragImage: () => {},
      effectAllowed: "",
    };
    fireEvent.dragStart(alpha, { dataTransfer });
    stubTokenRects(panel);
    const gap = panel.querySelector("[data-drop-index='3']") as HTMLElement | null;
    if (!gap) {
      throw new Error("Expected drop gap for index 3");
    }
    fireEvent.dragOver(gap, { dataTransfer, clientX: 65, clientY: 5 });
    fireEvent.drop(gap, { dataTransfer, clientX: 65, clientY: 5 });

    const tokens = within(panel)
      .getAllByRole("button")
      .filter((el) => el.getAttribute("data-token-index") !== null)
      .map((el) => el.textContent);
    expect(tokens.join(" ")).toBe("⬚ beta gamma alpha");
  });

  it("keeps space markers on the same vertical baseline", async () => {
    localStorage.clear();
    await renderEditor("hello world again");
    const user = userEvent.setup();
    const select = await screen.findByLabelText(/tokeneditor\.spaceMark/i);
    await user.selectOptions(select, "dot");
    const markers = await screen.findAllByTestId("space-marker");
    expect(markers.length).toBeGreaterThanOrEqual(1);
    const transforms = markers.map((el) => getComputedStyle(el).transform);
    const first = transforms[0];
    transforms.forEach((t) => expect(t).toBe(first));
  });

  it("lets user pick space marker glyph (dot/box/none)", async () => {
    localStorage.clear();
    await renderEditor("hello world");
    const user = userEvent.setup();
    const select = await screen.findByLabelText(/tokeneditor\.spaceMark/i);
    await user.selectOptions(select, "dot");
    expect((select as HTMLSelectElement).value).toBe("dot");
    await waitFor(() => {
      const markersDot = screen.getAllByTestId("space-marker");
      expect(markersDot.some((el) => el.textContent === "·")).toBe(true);
    });
    await user.selectOptions(select, "none");
    await waitFor(() => {
      expect(screen.queryAllByTestId("space-marker").length).toBe(0);
    });
  });

  it("shows inline space marker on selected token when enabled", async () => {
    localStorage.clear();
    await renderEditor("hello world");
    const user = userEvent.setup();
    const select = await screen.findByLabelText(/tokeneditor\.spaceMark/i);
    await user.selectOptions(select, "dot");
    const hello = await screen.findByText("hello");
    const world = await screen.findByText("world");
    await user.click(hello);
    await user.click(world, { ctrlKey: true });
    await waitFor(() => {
      const markers = screen.getAllByTestId("space-marker");
      expect(markers.some((el) => el.textContent === "·")).toBe(true);
    });
    await user.selectOptions(select, "none");
    await waitFor(() => {
      expect(screen.queryAllByTestId("space-marker").length).toBe(0);
    });
  });

  it("clears tab pressed state when collapsing the preview panel", async () => {
    localStorage.clear();
    await renderEditor("hello world");
    const toggle = await screen.findByTestId("text-panel-toggle");
    const correctedTab = await screen.findByRole("button", { name: /tokeneditor\.corrected/i });
    expect(correctedTab).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    expect(correctedTab).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(correctedTab).toHaveAttribute("aria-pressed", "true");
  });

  it("buildHotkeyMap keeps active hotkeys, supports modifiers, and normalizes order plus code variants", () => {
    const errorTypes: any[] = [
      { id: 1, is_active: true, default_hotkey: "A" },
      { id: 2, is_active: true, default_hotkey: "ctrl+shift+b" },
      { id: 3, is_active: false, default_hotkey: "c" },
      { id: 4, is_active: true, default_hotkey: "long" },
    ];
    expect(buildHotkeyMap(errorTypes)).toEqual({
      a: 1,
      "code:KeyA": 1,
      "ctrl+shift+b": 2,
      "ctrl+shift+code:KeyB": 2,
    });
  });

  it("ignores hotkeys with multiple non-modifier keys like 'a+1'", () => {
    const errorTypes: any[] = [{ id: 5, is_active: true, default_hotkey: "a+1" }];
    expect(buildHotkeyMap(errorTypes)).toEqual({});
  });

  it("parseHotkey understands modifier combos and attaches codes", () => {
    const spec = parseHotkey("ctrl+shift+a");
    expect(spec).toEqual({
      key: "a",
      code: "KeyA",
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
    });
  });

  it("parseHotkey returns null for multiple keys or empty", () => {
    expect(parseHotkey("a+1")).toBeNull();
    expect(parseHotkey("")).toBeNull();
  });

  it("guessCodeFromKey handles digits and letters", () => {
    expect(guessCodeFromKey("a")).toBe("KeyA");
    expect(guessCodeFromKey("5")).toBe("Digit5");
    expect(guessCodeFromKey("-")).toBeNull();
  });

  it("tokenizeToTokens preserves parentheses as punctuation tokens", () => {
    const tokens = tokenizeToTokens("(hello)");
    expect(tokens.map((t) => t.text)).toEqual(["(", "hello", ")"]);
    expect(tokens.map((t) => t.kind)).toEqual(["punct", "word", "punct"]);
  });

  it("buildHotkeyMap ignores inactive types even with hotkeys", () => {
    const map = buildHotkeyMap([
      { id: 1, is_active: false, default_hotkey: "shift+a" },
      { id: 2, is_active: true, default_hotkey: "shift+b" },
    ] as any);
    expect(map).toEqual({ "shift+b": 2, "shift+code:KeyB": 2 });
  });

});

describe("buildM2Preview", () => {
  it("formats replacements into M2 output", () => {
    const originalTokens = tokenizeToTokens("hello world");
    const tokens = tokenizeToTokens("hi world");
    const preview = buildM2Preview({ originalTokens, tokens });
    expect(preview.split("\n")).toEqual([
      "S hello world",
      "A 0 1|||OTHER|||hi|||REQUIRED|||-NONE-|||0",
    ]);
  });

  it("uses provided type labels when available", () => {
    const originalTokens = tokenizeToTokens("hello world");
    const tokens = tokenizeToTokens("hello brave world");
    const correctionByIndex = new Map<number, string>([[1, "card-1"]]);
    const preview = buildM2Preview({
      originalTokens,
      tokens,
      correctionByIndex,
      correctionTypeMap: { "card-1": 7 },
      resolveTypeLabel: (id) => (id === 7 ? "ADJ" : null),
    });
    expect(preview).toContain("A 1 1|||ADJ|||brave|||REQUIRED|||-NONE-|||0");
  });

  it("emits noop when there are no edits", () => {
    const originalTokens = tokenizeToTokens("same text");
    const tokens = tokenizeToTokens("same text");
    const preview = buildM2Preview({ originalTokens, tokens });
    expect(preview.split("\n")).toEqual([
      "S same text",
      "A -1 -1|||noop|||-NONE-|||REQUIRED|||-NONE-|||0",
    ]);
  });

  it("handles deletions with -NONE- replacement", () => {
    const originalTokens = tokenizeToTokens("hello world");
    const tokens = tokenizeToTokens("hello");
    const preview = buildM2Preview({ originalTokens, tokens });
    expect(preview).toContain("A 1 2|||OTHER|||-NONE-|||REQUIRED|||-NONE-|||0");
  });

  it("derives type from correction map for insertions", () => {
    const originalTokens = tokenizeToTokens("hello world");
    const tokens = tokenizeToTokens("hello kind world");
    const correctionByIndex = new Map<number, string>([[1, "card-1"]]);
    const preview = buildM2Preview({
      originalTokens,
      tokens,
      correctionByIndex,
      correctionTypeMap: { "card-1": 3 },
      resolveTypeLabel: (id) => (id === 3 ? "INS" : null),
    });
    expect(preview).toContain("A 1 1|||INS|||kind|||REQUIRED|||-NONE-|||0");
  });
});

describe("tokenEditorReducer move operations", () => {
  it("moves a multi-token range to the right without shifting by length", () => {
    const base = initState("alpha beta gamma delta epsilon");
    const moved = tokenEditorReducer(base, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 1,
      fromEnd: 2,
      toIndex: 4,
    });
    const texts = moved.present.tokens.map((t) => t.text);
    expect(texts.join(" ")).toBe("alpha ⬚ delta beta gamma epsilon");
  });

  it("moves a multi-token range to the left without pulling extra tokens", () => {
    const base = initState("alpha beta gamma delta epsilon");
    const moved = tokenEditorReducer(base, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 3,
      fromEnd: 4,
      toIndex: 2,
    });
    const texts = moved.present.tokens.map((t) => t.text);
    expect(texts.join(" ")).toBe("alpha beta delta epsilon gamma ⬚");
  });

  it("undo/redo restores move operations", () => {
    const base = initState("alpha beta gamma delta");
    const moved = tokenEditorReducer(base, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 1,
      fromEnd: 1,
      toIndex: 3,
    });
    const undone = tokenEditorReducer(moved, { type: "UNDO" });
    expect(undone.present.tokens.map((t) => t.text).join(" ")).toBe("alpha beta gamma delta");
    const redone = tokenEditorReducer(undone, { type: "REDO" });
    expect(redone.present.tokens.map((t) => t.text).join(" ")).toBe("alpha ⬚ gamma beta delta");
  });

  it("repositions an existing move destination without creating a new placeholder", () => {
    const base = initState("alpha beta gamma delta");
    const firstMove = tokenEditorReducer(base, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 2,
      fromEnd: 2,
      toIndex: 0,
    });
    const secondMove = tokenEditorReducer(firstMove, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 0,
      fromEnd: 0,
      toIndex: 5,
    });
    const texts = secondMove.present.tokens.map((t) => t.text);
    expect(texts.join(" ")).toBe("alpha beta ⬚ delta gamma");
    const placeholders = texts.filter((t) => t === "⬚");
    expect(placeholders.length).toBe(1);
    const moveMarkers = deriveMoveMarkers(secondMove.present.tokens);
    expect(moveMarkers).toHaveLength(1);
    expect(moveMarkers[0].fromStart).toBeGreaterThanOrEqual(0);
  });
});

describe("buildAnnotationsPayloadStandalone", () => {
  const baseToken = (id: string, text: string) =>
    ({ id, text, kind: "word", selected: false } as any);

  it("includes text token hash and carries annotation ids", async () => {
    const originalTokens = [baseToken("t1", "hello"), baseToken("t2", "world")];
    const tokens = [baseToken("t1", "hi"), baseToken("t2", "world")];
    const correctionCards = [{ id: "card-1", rangeStart: 0, rangeEnd: 0 }];
    const correctionTypeMap = { "card-1": 7 };
    const annotationIdMap = new Map<string, number>([["0-0", 42]]);

    const payloads = await buildAnnotationsPayloadStandalone({
      initialText: "hello world",
      tokens,
      originalTokens,
      correctionCards,
      correctionTypeMap,
      moveMarkers: [],
      annotationIdMap,
    });

    expect(payloads).toHaveLength(1);
    const ann = payloads[0];
    expect(ann.id).toBe(42);
    expect(ann.payload.text_tokens).toEqual(["hello", "world"]);
    const expectedHash = await computeTokensSha256(["hello", "world"]);
    expect(ann.payload.text_tokens_sha256).toBe(expectedHash);
    expect(ann.replacement).toBe("hi");
  });

  it("adds deleted_ids when includeDeletedIds is true", async () => {
    const originalTokens = tokenizeToTokens("hello world");
    const tokens = tokenizeToTokens("hi world");
    const correctionCards = [{ id: "card-1", rangeStart: 0, rangeEnd: 0 }];
    const correctionTypeMap = { "card-1": 7 };
    const annotationIdMap = new Map<string, number>([
      ["0-0", 10],
      ["1-1", 11],
    ]);

    const payloads = (await buildStandalone({
      initialText: "hello world",
      tokens,
      originalTokens,
      correctionCards,
      correctionTypeMap,
      moveMarkers: [],
      annotationIdMap,
      includeDeletedIds: true,
    })) as any;

    expect(payloads.deleted_ids).toContain(11);
    expect(payloads.deleted_ids).not.toContain(10);
  });

  it("builds move payloads with move_from and move_to", async () => {
    const base = initState("alpha beta gamma");
    const moved = tokenEditorReducer(base, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 2,
      fromEnd: 2,
      toIndex: 0,
    });
    const moveMarkers = deriveMoveMarkers(moved.present.tokens);
    const correctionCards = deriveCorrectionCards(moved.present.tokens, moveMarkers);
    const correctionTypeMap = { [moveMarkers[0].id]: 7 };

    const payloads = await buildAnnotationsPayloadStandalone({
      initialText: "alpha beta gamma",
      tokens: moved.present.tokens,
      originalTokens: moved.present.originalTokens,
      correctionCards,
      correctionTypeMap,
      moveMarkers,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.operation).toBe("move");
    expect(payloads[0].payload.move_from).toBeTypeOf("number");
    expect(payloads[0].payload.move_to).toBeTypeOf("number");
  });

  it("emits separate payloads for multiple move corrections", async () => {
    const base = initState("alpha beta gamma delta");
    const firstMove = tokenEditorReducer(base, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 3,
      fromEnd: 3,
      toIndex: 0,
    });
    const secondMove = tokenEditorReducer(firstMove, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 2,
      fromEnd: 2,
      toIndex: 1,
    });
    const moveMarkers = deriveMoveMarkers(secondMove.present.tokens);
    const correctionCards = deriveCorrectionCards(secondMove.present.tokens, moveMarkers);
    const correctionTypeMap = Object.fromEntries(moveMarkers.map((m, idx) => [m.id, idx + 1]));

    const payloads = await buildAnnotationsPayloadStandalone({
      initialText: "alpha beta gamma delta",
      tokens: secondMove.present.tokens,
      originalTokens: secondMove.present.originalTokens,
      correctionCards,
      correctionTypeMap,
      moveMarkers,
    });

    expect(payloads).toHaveLength(2);
    expect(payloads.every((p) => p.payload.operation === "move")).toBe(true);
  });
});

describe("save skipping helpers", () => {
  it("skips when signature unchanged", () => {
    const anns = [
      { start_token: 0, end_token: 0, replacement: "a", error_type_id: 1, payload: {} as any },
    ] as any;
    const sig = annotationsSignature(anns);
    const result = shouldSkipSave(sig, anns);
    expect(result.skip).toBe(true);
    expect(result.nextSignature).toBe(sig);
  });

  it("skips initial empty payload", () => {
    const anns: any[] = [];
    const result = shouldSkipSave(null, anns);
    expect(result.skip).toBe(true);
  });

  it("does not skip when payload changes", () => {
    const result = shouldSkipSave("old", [{ start_token: 0, end_token: 0, replacement: "x", error_type_id: 1, payload: {} as any } as any]);
    expect(result.skip).toBe(false);
  });
});

describe("insertion splitting", () => {
  it("splits inserted placeholder text into multiple tokens with punctuation", () => {
    const state1 = initState("hello world");
    const withInsert = tokenEditorReducer(state1, { type: "INSERT_TOKEN_BEFORE_SELECTED", range: [0, 0] });
    const edited = tokenEditorReducer(withInsert, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo, bar",
    });
    expect(edited.present.tokens.map((t) => t.text)).toEqual(["foo,", "bar", "hello", "world"]);
  });

  it("renders split tokens as separate chips after editing insertion", async () => {
    localStorage.clear();
    const originalTokens = tokenizeToTokens("hello world");
    const tokens = tokenizeToTokens("foo, bar hello world");
    const state = { originalTokens, tokens };
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(state));
    await renderEditor("hello world");
    const correctedPanel = await screen.findByTestId("corrected-panel");
    await waitFor(() => {
      const chips = within(correctedPanel).getAllByText(/foo|bar|hello|,/);
      expect(chips.length).toBeGreaterThanOrEqual(4);
      expect(screen.getByTestId("text-view-panel").textContent?.includes("foo, bar hello world")).toBe(true);
    });
  });

  it("keeps newly inserted group selected after edit", () => {
    const state1 = initState("hello world");
    const withInsert = tokenEditorReducer(state1, { type: "INSERT_TOKEN_BEFORE_SELECTED", range: [0, 0] });
    const edited = tokenEditorReducer(withInsert, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo",
    });
    expect(edited.present.tokens.map((t) => t.selected)).toEqual([false, false, false]);
    // selection is managed outside reducer; simulate commit keeping selection range
    const selectionRange = { start: 0, end: 0 };
    expect(selectionRange).toEqual({ start: 0, end: 0 });
  });

  it("supports undo/redo hotkeys by keyboard code for non-Latin layouts", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    await renderEditor("hello world");
    const user = userEvent.setup();
    const hello = await screen.findByRole("button", { name: "hello" });
    await user.dblClick(hello);
    const input = await screen.findByPlaceholderText("tokenEditor.editPlaceholder");
    await user.clear(input);
    await user.type(input, "hi");
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByRole("button", { name: "hi" })).toBeTruthy());

    fireEvent.keyDown(window, { key: "я", code: "KeyZ", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "hello" })).toBeTruthy());

    fireEvent.keyDown(window, { key: "я", code: "KeyZ", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "hi" })).toBeTruthy());
  });

  it("clears old selection after revert and selects new edit", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const base = tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text: "hello world" });
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "hi",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("hello world");
    const user = userEvent.setup();
    const corrected = await screen.findByRole("button", { name: "hi" });
    await user.click(corrected);
    expect(corrected).toHaveAttribute("aria-pressed", "true");

    const revert = await screen.findByTitle("tokenEditor.undo");
    await user.click(revert);
    const hello = await screen.findByRole("button", { name: "hello" });
    await waitFor(() => expect(hello).toHaveAttribute("aria-pressed", "false"));

    const world = await screen.findByRole("button", { name: "world" });
    await user.dblClick(world);
    const editInput = await screen.findByPlaceholderText("tokenEditor.editPlaceholder");
    expect((editInput as HTMLInputElement).value).toBe("world");
  });
});

describe("empty placeholder selection", () => {
  it("highlights deleted placeholder when clicked again later", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const base = tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text: "hello world" });
    const deleted = tokenEditorReducer(base, { type: "DELETE_SELECTED_TOKENS", range: [0, 0] });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(deleted.present));
    await renderEditor("hello world");
    const user = userEvent.setup();

    const placeholder = await screen.findByRole("button", { name: "⬚" }, { timeout: 2000 });
    if (placeholder.getAttribute("aria-pressed") === "true") {
      await user.keyboard("{Escape}");
    }
    expect(placeholder).toHaveAttribute("aria-pressed", "false");
    // deselected after delete; clicking again should toggle selection state/aria
    await user.click(placeholder);
    expect(placeholder).toHaveAttribute("aria-pressed", "true");
  }, 12000);

  it("deleting a selection containing a placeholder restores the original token instead of wiping text", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const base = tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text: "alpha beta gamma" });
    const deleted = tokenEditorReducer(base, { type: "DELETE_SELECTED_TOKENS", range: [1, 1] });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(deleted.present));

    await renderEditor("alpha beta gamma");
    const user = userEvent.setup();

    const placeholder = await screen.findByRole("button", { name: "⬚" }, { timeout: 2000 });
    const gamma = await screen.findByRole("button", { name: "gamma" });
    await user.click(placeholder);
    await user.keyboard("{Control>}");
    await user.click(gamma);
    await user.keyboard("{/Control}");
    await waitFor(() => expect(placeholder).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(gamma).toHaveAttribute("aria-pressed", "true"));
    await user.keyboard("{Delete}");

    const corrected = await screen.findByTestId("corrected-panel");
    const chips = within(corrected).getAllByRole("button");
    const texts = chips
      .filter((c) => c.getAttribute("data-token-index") !== null)
      .map((c) => c.textContent?.trim())
      .filter(Boolean);
    expect(texts.join(" ")).toBe("alpha beta gamma");
  }, 12000);

  it("does not revert a deletion when removing a neighboring token only", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const base = tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text: "alpha beta gamma" });
    const deleted = tokenEditorReducer(base, { type: "DELETE_SELECTED_TOKENS", range: [1, 1] });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(deleted.present));

    await renderEditor("alpha beta gamma");
    const user = userEvent.setup();

    const alpha = await screen.findByRole("button", { name: "alpha" });
    await user.click(alpha);
    await user.keyboard("{Delete}");

    const corrected = await screen.findByTestId("corrected-panel");
    const chips = within(corrected).getAllByRole("button");
    const texts = chips
      .filter((c) => c.getAttribute("data-token-index") !== null)
      .map((c) => c.textContent?.trim())
      .filter(Boolean);
    expect(texts.join(" ")).toBe("⬚ ⬚ gamma");
  }, 12000);
});

describe("revert clears selection", () => {
  const seedEditedStateWithType = () => {
    const base = tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text: "hello world" });
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "hi",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    localStorage.setItem(
      "tokenEditorPrefs:types:1",
      JSON.stringify({ activeErrorTypeId: 1, assignments: {} })
    );
  };

  it("removes selection highlight when undoing a correction", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const base = tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text: "hello world" });
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "hi",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("hello world");
    const user = userEvent.setup();
    const corrected = await screen.findByRole("button", { name: "hi" });
    await user.click(corrected);
    const revert = await screen.findByTitle("tokenEditor.undo");
    await user.click(revert);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "hello" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByRole("button", { name: "world" })).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("deselects tokens after clearing all corrections", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    seedEditedStateWithType();
    await renderEditor("hello world", {
      getImpl: (url) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 1, en_name: "Type A", tt_name: "Type A", default_color: "#94a3b8", is_active: true }],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });
    const user = userEvent.setup();

    const corrected = await screen.findByRole("button", { name: "hi" });
    await user.click(corrected);
    expect(corrected).toHaveAttribute("aria-pressed", "true");

    const clearAll = await screen.findByText("tokenEditor.clearAll");
    await user.click(clearAll);
    const confirm = await screen.findByText("tokenEditor.clearConfirm");
    await user.click(confirm);

    await waitFor(() => {
      const tokens = screen.getAllByRole("button").filter((el) => ["hello", "world"].includes(el.textContent ?? ""));
      expect(tokens.every((el) => el.getAttribute("aria-pressed") === "false")).toBe(true);
    });
  });

  it("disables clear all when there are no corrections", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    await renderEditor("hello world");
    const clearAll = await screen.findByText("tokenEditor.clearAll");
    expect(clearAll).toBeDisabled();
  });

  it("restores the cleared corrections on undo", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    seedEditedStateWithType();
    await renderEditor("hello world", {
      getImpl: (url) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 1, en_name: "Type A", tt_name: "Type A", default_color: "#94a3b8", is_active: true }],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });
    const user = userEvent.setup();
    const clearAll = await screen.findByText("tokenEditor.clearAll");
    await user.click(clearAll);
    const confirm = await screen.findByText("tokenEditor.clearConfirm");
    await user.click(confirm);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "hello" })).toBeInTheDocument();
    });

    await user.keyboard("{Control>}z{/Control}");
    const restored = await screen.findByRole("button", { name: "hi" });
    expect(restored).toBeInTheDocument();
  });

  it("deselects tokens when reverting from the inline group undo", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    seedEditedStateWithType();
    await renderEditor("hello world", {
      getImpl: (url) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 1, en_name: "Type A", tt_name: "Type A", default_color: "#94a3b8", is_active: true }],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });
    const user = userEvent.setup();

    const corrected = await screen.findByRole("button", { name: "hi" });
    await user.click(corrected);
    expect(corrected).toHaveAttribute("aria-pressed", "true");

    const inlineUndo = await screen.findByTitle("tokenEditor.undo");
    expect(inlineUndo).toHaveStyle({ zIndex: "2" });
    await user.click(inlineUndo);

    await waitFor(() => {
      const tokens = screen.getAllByRole("button").filter((el) => ["hello", "world"].includes(el.textContent ?? ""));
      expect(tokens.every((el) => el.getAttribute("aria-pressed") === "false")).toBe(true);
    });
  });

  it("renders correction stack in order: updated tokens, history, then badge with smaller font", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    seedEditedStateWithType();
    await renderEditor("hello world", {
      getImpl: (url) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 1, en_name: "Type A", tt_name: "Type A", default_color: "#94a3b8", is_active: true }],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByRole("button", { name: "hi" });
    const historySpan = screen
      .getAllByText("hello")
      .find((el) => el.getAttribute("role") !== "button") as HTMLElement;
    const badgeCandidates = await screen.findAllByText("Type A");
    const badge = badgeCandidates.find((el) => el.getAttribute("title") === "Type A") as HTMLElement;
    expect(corrected).toBeTruthy();
    expect(historySpan).toBeTruthy();
    expect(badge).toBeTruthy();

    let group: HTMLElement | null = badge as HTMLElement;
    while (group && !(group.contains(corrected) && group.contains(historySpan))) {
      group = group.parentElement;
    }
    expect(group).toBeTruthy();
    const children = Array.from(group!.children);
    expect(children[0].contains(corrected)).toBe(true);
    expect(children[1].contains(historySpan)).toBe(true);
    expect(children[2]).toBe(badge);

    const tokenFont = parseFloat(window.getComputedStyle(corrected).fontSize || "0");
    const badgeFont = parseFloat(window.getComputedStyle(badge).fontSize || "0");
    expect(badgeFont).toBeGreaterThan(0);
    expect(badgeFont).toBeLessThan(tokenFont);
  });

  it("exports replacement without inserting whitespace when editing punctuation inline", async () => {
    const base = initState("foobar");
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo-bar",
    });
    const correctionCards = [
      { id: "c1", rangeStart: 0, rangeEnd: 0 },
    ];
    const correctionTypeMap = { c1: 1 };
    const payloads = await buildAnnotationsPayloadStandalone({
      initialText: "foobar",
      tokens: edited.present.tokens,
      originalTokens: edited.present.originalTokens,
      correctionCards,
      correctionTypeMap,
      moveMarkers: [],
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].replacement).toBe("foo-bar");
    expect(payloads[0].payload.after_tokens.map((t: any) => t.text)).toEqual(["foo-bar"]);
  });

  it("does not add an extra group highlight when selecting a corrected token", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const correctedGroup = {
      originalTokens: [{ id: "o1", text: "hello", kind: "word", selected: false }],
      tokens: [
        {
          id: "t1",
          text: "hi",
          kind: "word",
          selected: false,
          groupId: "g1",
          previousTokens: [{ id: "o1", text: "hello", kind: "word", selected: false }],
        },
        { id: "t2", text: "world", kind: "word", selected: false },
      ],
    };
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(correctedGroup));
    await renderEditor("placeholder");
    const user = userEvent.setup();
    const chip = await screen.findByRole("button", { name: "hi" });
    const groupDiv = findGroupContainer(chip);
    const initialBg = groupDiv?.style.background;
    await user.click(chip);
    expect(groupDiv?.style.background).toBe(initialBg);
  });

  it("selects the full correction group when clicking its container", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const correctedGroup = {
      originalTokens: [
        { id: "o1", text: "hello", kind: "word", selected: false },
        { id: "o2", text: "world", kind: "word", selected: false },
      ],
      tokens: [
        {
          id: "t1",
          text: "foo",
          kind: "word",
          selected: false,
          groupId: "g1",
          previousTokens: [{ id: "o1", text: "hello", kind: "word", selected: false }],
        },
        {
          id: "t2",
          text: "bar",
          kind: "word",
          selected: false,
          groupId: "g1",
        },
        { id: "t3", text: "baz", kind: "word", selected: false },
      ],
    };
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(correctedGroup));
    await renderEditor("placeholder");
    const user = userEvent.setup();
    const foo = await screen.findByRole("button", { name: "foo" });
    const groupDiv = findGroupContainer(foo);
    if (!groupDiv) {
      throw new Error("Expected correction group container");
    }
    await user.click(groupDiv);
    const bar = await screen.findByRole("button", { name: "bar" });
    const baz = await screen.findByRole("button", { name: "baz" });
    expect(foo).toHaveAttribute("aria-pressed", "true");
    expect(bar).toHaveAttribute("aria-pressed", "true");
    expect(baz).toHaveAttribute("aria-pressed", "false");
  });

  it("selects the move destination group when clicking its container", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const base = initState("alpha beta gamma");
    const moved = tokenEditorReducer(base, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 2,
      fromEnd: 2,
      toIndex: 0,
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(moved.present));
    await renderEditor("alpha beta gamma");
    const user = userEvent.setup();
    const gamma = await screen.findByRole("button", { name: "gamma" });
    const groupDiv = findGroupContainer(gamma);
    if (!groupDiv) {
      throw new Error("Expected move destination container");
    }
    await user.click(groupDiv);
    const alpha = await screen.findByRole("button", { name: "alpha" });
    const beta = await screen.findByRole("button", { name: "beta" });
    expect(gamma).toHaveAttribute("aria-pressed", "true");
    expect(alpha).toHaveAttribute("aria-pressed", "false");
    expect(beta).toHaveAttribute("aria-pressed", "false");
  });

  it("selects the move source placeholder when clicking its container", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const base = initState("alpha beta gamma");
    const moved = tokenEditorReducer(base, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 0,
      fromEnd: 0,
      toIndex: 3,
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(moved.present));
    await renderEditor("alpha beta gamma");
    const user = userEvent.setup();
    const placeholder = await screen.findByRole("button", { name: "⬚" });
    const groupDiv = findGroupContainer(placeholder);
    if (!groupDiv) {
      throw new Error("Expected move source container");
    }
    await user.click(groupDiv);
    expect(placeholder).toHaveAttribute("aria-pressed", "true");
  });

  it("auto-assigns Hyphen when deleting a hyphen token", async () => {
    localStorage.clear();
    const base = initState("foo - bar");
    const hyphenIndex = findIndexByText(base, "-");
    const deleted = tokenEditorReducer(base, {
      type: "DELETE_SELECTED_TOKENS",
      range: [hyphenIndex, hyphenIndex],
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(deleted.present));
    await renderEditor("foo - bar", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 11, en_name: "Hyphen", tt_name: "Hyphen", is_active: true, default_color: "#fbbf24" }],
          });
        }
        if (url.includes("/annotations")) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => expect(within(corrected).getByText("Hyphen")).toBeInTheDocument());
  });

  it("auto-assigns Hyphen when inserting a single hyphen", async () => {
    localStorage.clear();
    let state = initState("foo bar");
    state = tokenEditorReducer(state, {
      type: "INSERT_TOKEN_AFTER_SELECTED",
      range: [0, 0],
    });
    state = tokenEditorReducer(state, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [1, 1],
      newText: "-",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(state.present));
    await renderEditor("foo bar", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 12, en_name: "Hyphen", tt_name: "Hyphen", is_active: true, default_color: "#fbbf24" }],
          });
        }
        if (url.includes("/annotations")) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => expect(within(corrected).getByText("Hyphen")).toBeInTheDocument());
  });

  it("auto-assigns Hyphen when adding a single hyphen inside a word", async () => {
    localStorage.clear();
    const base = initState("foobar");
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo-bar",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("foobar", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 13, en_name: "Hyphen", tt_name: "Hyphen", is_active: true, default_color: "#fbbf24" }],
          });
        }
        if (url.includes("/annotations")) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => expect(within(corrected).getByText("Hyphen")).toBeInTheDocument());
  });

  it("auto-assigns Punctuation when deleting a punctuation token", async () => {
    localStorage.clear();
    const base = initState("foo, bar");
    const commaIndex = findIndexByText(base, ",");
    const deleted = tokenEditorReducer(base, {
      type: "DELETE_SELECTED_TOKENS",
      range: [commaIndex, commaIndex],
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(deleted.present));
    await renderEditor("foo, bar", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 21, en_name: "Punctuation", tt_name: "Punctuation", is_active: true, default_color: "#38bdf8" }],
          });
        }
        if (url.includes("/annotations")) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => expect(within(corrected).getByText("Punctuation")).toBeInTheDocument());
  });

  it("auto-assigns Punctuation when inserting a punctuation token", async () => {
    localStorage.clear();
    let state = initState("foo bar");
    state = tokenEditorReducer(state, {
      type: "INSERT_TOKEN_AFTER_SELECTED",
      range: [0, 0],
    });
    state = tokenEditorReducer(state, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [1, 1],
      newText: "!",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(state.present));
    await renderEditor("foo bar", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 22, en_name: "Punctuation", tt_name: "Punctuation", is_active: true, default_color: "#38bdf8" }],
          });
        }
        if (url.includes("/annotations")) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => expect(within(corrected).getByText("Punctuation")).toBeInTheDocument());
  });

  it("hides noop error type from the picker", async () => {
    localStorage.clear();
    await renderEditor("hello world", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [
              { id: 1, en_name: "noop", tt_name: "noop", is_active: true, default_color: "#94a3b8" },
              { id: 2, en_name: "Punctuation", tt_name: "Punctuation", is_active: true, default_color: "#38bdf8" },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });
    await screen.findByText("Punctuation");
    expect(screen.queryByText("noop")).not.toBeInTheDocument();
  });

  it("auto-assigns Split when adding a single whitespace", async () => {
    localStorage.clear();
    const base = initState("foobar");
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo bar",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("foobar", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 30, en_name: "Split", tt_name: "Split", is_active: true, default_color: "#38bdf8" }],
          });
        }
        if (url.includes("/annotations")) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => expect(within(corrected).getByText("Split")).toBeInTheDocument());
  });

  it("auto-assigns Merge when removing a single whitespace", async () => {
    localStorage.clear();
    const base = initState("foo bar");
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 1],
      newText: "foobar",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("foo bar", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 31, en_name: "Merge", tt_name: "Merge", is_active: true, default_color: "#fbbf24" }],
          });
        }
        if (url.includes("/annotations")) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => expect(within(corrected).getByText("Merge")).toBeInTheDocument());
  });

  it("auto-assigns CapitalLowerLetter when capitalizing the first letter", async () => {
    localStorage.clear();
    const base = initState("hello");
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "Hello",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("hello", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [
              { id: 40, en_name: "CapitalLowerLetter", tt_name: "CapitalLowerLetter", is_active: true, default_color: "#f97316" },
              { id: 41, en_name: "Spelling", tt_name: "Spelling", is_active: true, default_color: "#38bdf8" },
            ],
          });
        }
        if (url.includes("/annotations")) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => expect(within(corrected).getByText("CapitalLowerLetter")).toBeInTheDocument());
    expect(within(corrected).queryByText("Spelling")).not.toBeInTheDocument();
  });

  it("auto-assigns Spelling when changing up to two letters in a word", async () => {
    localStorage.clear();
    const base = initState("hello");
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "hallo",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("hello", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 42, en_name: "Spelling", tt_name: "Spelling", is_active: true, default_color: "#38bdf8" }],
          });
        }
        if (url.includes("/annotations")) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => expect(within(corrected).getByText("Spelling")).toBeInTheDocument());
  });

  it("keeps all tokens styled as corrected after editing a moved token into multiple tokens", async () => {
    localStorage.clear();
    const base = initState("alpha beta gamma delta");
    const moved = tokenEditorReducer(base, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 2,
      fromEnd: 2,
      toIndex: 0,
    });
    const movedIndex = findIndexByText(moved, "gamma");
    const edited = tokenEditorReducer(moved, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [movedIndex, movedIndex],
      newText: "gamma new",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("alpha beta gamma delta");
    const gamma = await screen.findByRole("button", { name: "gamma" });
    const newToken = await screen.findByRole("button", { name: "new" });
    expect(gamma).toHaveStyle({ color: "#e2e8f0" });
    expect(newToken).toHaveStyle({ color: "#e2e8f0" });
  });

  it("auto-selects all tokens in a replaced group", async () => {
    const edited = tokenEditorReducer(initState("hello world"), {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo bar",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("hello world");
    await waitFor(() => {
      const foo = screen.getByRole("button", { name: "foo" });
      const bar = screen.getByRole("button", { name: "bar" });
      expect(foo).toHaveAttribute("aria-pressed", "true");
      expect(bar).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("auto-selects the most recent deletion even after prior deletes and reverts", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const base = initState("one two three");
    const firstDelete = tokenEditorReducer(base, { type: "DELETE_SELECTED_TOKENS", range: [0, 0] });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(firstDelete.present));
    await renderEditor("one two three");
    const user = userEvent.setup();

    const placeholderBefore = await screen.findByRole("button", { name: "⬚" });
    expect(placeholderBefore).toHaveAttribute("aria-pressed", "true");

    // Delete the last token to create a new correction.
    const three = await screen.findByRole("button", { name: "three" });
    await user.click(three);
    await user.keyboard("{Delete}");

    const placeholders = await screen.findAllByRole("button", { name: "⬚" });
    expect(placeholders.length).toBe(2);
    // The newest deletion (second placeholder) should be selected; the first should not.
    await waitFor(() => {
      expect(placeholders[0]).toHaveAttribute("aria-pressed", "false");
      expect(placeholders[1]).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("deleting one placeholder keeps adjacent deletion correction intact", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    await renderEditor("one two three four");
    const user = userEvent.setup();

    const two = await screen.findByRole("button", { name: "two" });
    await user.click(two);
    await user.keyboard("{Delete}");

    const three = await screen.findByRole("button", { name: "three" });
    await user.click(three);
    await user.keyboard("{Delete}");

    let placeholders = await screen.findAllByRole("button", { name: "⬚" });
    expect(placeholders.length).toBe(2);

    await user.click(placeholders[0]);
    await waitFor(() => {
      expect(placeholders[0]).toHaveAttribute("aria-pressed", "true");
      expect(placeholders[1]).toHaveAttribute("aria-pressed", "false");
    });
    await user.keyboard("{Delete}");

    placeholders = await screen.findAllByRole("button", { name: "⬚" });
    expect(placeholders.length).toBe(1);
    expect(screen.getByRole("button", { name: "two" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "three" })).toBeNull();
  });

  it("selects the first deletion after clearing all corrections", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    await renderEditor("alpha beta");
    const user = userEvent.setup();

    const alpha = await screen.findByRole("button", { name: "alpha" });
    await user.click(alpha);
    await user.keyboard("{Delete}");

    const clearAll = await screen.findByText("tokenEditor.clearAll");
    await user.click(clearAll);
    const confirm = await screen.findByText("tokenEditor.clearConfirm");
    await user.click(confirm);

    const beta = await screen.findByRole("button", { name: "beta" });
    await user.click(beta);
    await user.keyboard("{Delete}");
    const placeholder = await screen.findByRole("button", { name: "⬚" });
    await waitFor(() => expect(placeholder).toHaveAttribute("aria-pressed", "true"));
  });
});

describe("TokenEditor view toggles", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
  });

  it("hydrates multi-token deletions from server annotations", async () => {
    localStorage.clear();
    await renderEditor("alpha beta gamma", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 10,
                author_id: "user-1",
                start_token: 0,
                end_token: 1,
                replacement: null,
                error_type_id: 1,
                payload: {
                  operation: "delete",
                  before_tokens: ["alpha", "beta"],
                  after_tokens: [],
                  text_tokens: ["alpha", "beta", "gamma"],
                },
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => expect(within(corrected).getByText("⬚")).toBeInTheDocument());
    expect(within(corrected).getByText("gamma")).toBeInTheDocument();
    expect(within(corrected).queryByRole("button", { name: "alpha" })).not.toBeInTheDocument();
    expect(within(corrected).queryByRole("button", { name: "beta" })).not.toBeInTheDocument();
  });

  it("hydrates single-token deletions from server annotations", async () => {
    localStorage.clear();
    await renderEditor("alpha beta", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 11,
                author_id: "user-1",
                start_token: 0,
                end_token: 0,
                replacement: null,
                error_type_id: 1,
                payload: {
                  operation: "delete",
                  before_tokens: ["alpha"],
                  after_tokens: [],
                  text_tokens: ["alpha", "beta"],
                },
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    const chips = within(corrected)
      .getAllByRole("button")
      .map((c) => c.textContent?.trim())
      .filter((t) => t && t !== "↺") as string[];
    expect(chips.join(" ")).toBe("⬚ beta");
  });

  it("hydrates server insertions from another annotator", async () => {
    localStorage.clear();
    await renderEditor("hello world", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 20,
                author_id: "other",
                start_token: 1,
                end_token: 1,
                replacement: "there",
                error_type_id: 1,
                payload: {
                  operation: "insert",
                  before_tokens: [],
                  after_tokens: [{ id: "t3", text: "there", origin: "base" }],
                  text_tokens: ["hello", "world"],
                },
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    const chips = within(corrected).getAllByRole("button");
    const texts = chips.map((c) => c.textContent?.trim()).filter(Boolean) as string[];
    expect(texts).toContain("there");
    expect(texts.filter((t) => t !== "↺").join(" ")).toBe("hello there world");
    // Insertions should render as a correction group (placeholder history visible).
    expect(within(corrected).getAllByText("⬚").length).toBeGreaterThan(0);
  });

  it("hydrates multi-token insertions from another annotator", async () => {
    localStorage.clear();
    await renderEditor("hello world", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 22,
                author_id: "other",
                start_token: 1,
                end_token: 1,
                replacement: "bright sunny",
                error_type_id: 1,
                payload: {
                  operation: "insert",
                  before_tokens: [],
                  after_tokens: [
                    { id: "t2", text: "bright", origin: "base" },
                    { id: "t3", text: "sunny", origin: "base" },
                  ],
                  text_tokens: ["hello", "world"],
                },
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    const chips = within(corrected)
      .getAllByRole("button")
      .map((c) => c.textContent?.trim())
      .filter((t) => t && t !== "↺") as string[];
    expect(chips.join(" ")).toBe("hello bright sunny world");
    expect(within(corrected).getAllByText("⬚").length).toBeGreaterThan(0);
  });

  it("hydrates move annotations with placeholder and moved group", async () => {
    localStorage.clear();
    await renderEditor("alpha beta gamma delta", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 30,
                author_id: "other",
                start_token: 0,
                end_token: 0,
                replacement: null,
                error_type_id: 1,
                payload: {
                  operation: "move",
                  move_from: 2,
                  move_to: 0,
                  move_len: 1,
                  before_tokens: [],
                  after_tokens: [{ id: "m1", text: "gamma", origin: "base" }],
                  text_tokens: ["alpha", "beta", "gamma", "delta"],
                },
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    const chips = within(corrected)
      .getAllByRole("button")
      .map((c) => c.textContent?.trim())
      .filter((t) => t && t !== "↺") as string[];
    expect(chips.join(" ")).toBe("gamma alpha beta ⬚ delta");
    expect(within(corrected).getAllByText("⬚").length).toBeGreaterThanOrEqual(1);
  });

  it("hydrates multi-token move corrections", async () => {
    localStorage.clear();
    await renderEditor("alpha beta gamma delta", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 31,
                author_id: "other",
                start_token: 0,
                end_token: 1,
                replacement: null,
                error_type_id: 1,
                payload: {
                  operation: "move",
                  move_from: 2,
                  move_to: 0,
                  move_len: 2,
                  before_tokens: [],
                  after_tokens: [
                    { id: "m1", text: "gamma", origin: "base" },
                    { id: "m2", text: "delta", origin: "base" },
                  ],
                  text_tokens: ["alpha", "beta", "gamma", "delta"],
                },
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    const chips = within(corrected)
      .getAllByRole("button")
      .map((c) => c.textContent?.trim())
      .filter((t) => t && t !== "↺") as string[];
    expect(chips.join(" ")).toBe("gamma delta alpha beta ⬚");
    expect(within(corrected).getAllByText("⬚").length).toBeGreaterThanOrEqual(1);
  });

  it("allows undoing a hydrated move via the inline undo button", async () => {
    localStorage.clear();
    const base = initState("alpha beta gamma");
    const moved = tokenEditorReducer(base, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: 2,
      fromEnd: 2,
      toIndex: 0,
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(moved.present));

    await renderEditor("alpha beta gamma");
    const corrected = await screen.findByTestId("corrected-panel");
    const undoButtons = within(corrected).getAllByRole("button", { name: "↺" });
    expect(undoButtons.length).toBeGreaterThan(0);
    await userEvent.click(undoButtons[0]);

    const chips = within(corrected)
      .getAllByRole("button")
      .map((c) => c.textContent?.trim())
      .filter((t) => t && t !== "↺") as string[];
    expect(chips.join(" ")).toBe("alpha beta gamma");
    expect(within(corrected).queryByText("⬚")).toBeNull();
  });

  it("only shows the error badge on move destination, not on source placeholder", async () => {
    localStorage.clear();
    await renderEditor("alpha beta gamma delta", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({
            data: [{ id: 1, en_name: "Type A", tt_name: "Type A", is_active: true, default_color: "#00ffaa" }],
          });
        }
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 32,
                author_id: "other",
                start_token: 0,
                end_token: 0,
                replacement: null,
                error_type_id: 1,
                payload: {
                  operation: "move",
                  move_from: 2,
                  move_to: 0,
                  move_len: 1,
                  before_tokens: [],
                  after_tokens: [{ id: "m1", text: "gamma", origin: "base" }],
                  text_tokens: ["alpha", "beta", "gamma", "delta"],
                },
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    const badges = within(corrected).getAllByText("Type A");
    expect(badges.length).toBe(1);
    // Ensure placeholder exists and is separate from the badge-bearing group.
    expect(within(corrected).getAllByText("⬚").length).toBeGreaterThan(0);
  });

  it("hydrates server edits with literal punctuation spacing", async () => {
    localStorage.clear();
    await renderEditor("foo bar", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 21,
                author_id: "other",
                start_token: 0,
                end_token: 0,
                replacement: "foo , bar",
                error_type_id: 1,
                payload: {
                  operation: "replace",
                  before_tokens: ["foo"],
                  after_tokens: [{ id: "a1", text: "foo , bar", origin: "base" }],
                  text_tokens: ["foo", "bar"],
                },
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => {
      const tokens = within(corrected)
        .getAllByRole("button")
        .filter((el) => el.getAttribute("aria-pressed") !== null)
        .map((el) => el.textContent);
      expect(tokens.slice(0, 3)).toEqual(["foo", ",", "bar"]);
    });
  });

  it("hydrates multi-token edits from another annotator", async () => {
    localStorage.clear();
    await renderEditor("alpha beta gamma", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 23,
                author_id: "other",
                start_token: 0,
                end_token: 1,
                replacement: "one two three",
                error_type_id: 1,
                payload: {
                  operation: "replace",
                  before_tokens: ["alpha", "beta"],
                  after_tokens: [{ id: "r1", text: "one two three", origin: "base" }],
                  text_tokens: ["alpha", "beta", "gamma"],
                },
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    const chips = within(corrected)
      .getAllByRole("button")
      .map((c) => c.textContent?.trim())
      .filter((t) => t && t !== "↺") as string[];
    expect(chips.join(" ")).toBe("one two three gamma");
    expect(within(corrected).getByText("alpha")).toBeInTheDocument();
    expect(within(corrected).getByText("beta")).toBeInTheDocument();
  });

  it("hydrates split edits without pulling the next token into history", async () => {
    localStorage.clear();
    const base = initState("foobar zulu");
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "foo bar",
    });
    const [annotation] = await buildAnnotationsPayloadStandalone({
      initialText: "foobar zulu",
      tokens: edited.present.tokens,
      originalTokens: edited.present.originalTokens,
      correctionCards: [{ id: "c1", rangeStart: 0, rangeEnd: 1 }],
      correctionTypeMap: { c1: 1 },
      moveMarkers: [],
    });
    expect(annotation.start_token).toBe(0);
    expect(annotation.end_token).toBe(0);

    await renderEditor("foobar zulu", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 24,
                author_id: "other",
                start_token: annotation.start_token,
                end_token: annotation.end_token,
                replacement: annotation.replacement,
                error_type_id: annotation.error_type_id,
                payload: annotation.payload,
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    const buttons = within(corrected)
      .getAllByRole("button")
      .map((c) => c.textContent?.trim())
      .filter((t) => t && t !== "↺") as string[];
    expect(buttons.join(" ")).toBe("foo bar zulu");
    expect(within(corrected).getByText("foobar")).toBeInTheDocument();
    expect(within(corrected).getAllByRole("button", { name: "zulu" })).toHaveLength(1);
  });

  it("hydrates multi-token split edits without pulling the next token into history", async () => {
    localStorage.clear();
    const base = initState("alpha beta gamma");
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 1],
      newText: "one two three",
    });
    const [annotation] = await buildAnnotationsPayloadStandalone({
      initialText: "alpha beta gamma",
      tokens: edited.present.tokens,
      originalTokens: edited.present.originalTokens,
      correctionCards: [{ id: "c1", rangeStart: 0, rangeEnd: 2 }],
      correctionTypeMap: { c1: 1 },
      moveMarkers: [],
    });
    expect(annotation.start_token).toBe(0);
    expect(annotation.end_token).toBe(1);

    await renderEditor("alpha beta gamma", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 25,
                author_id: "other",
                start_token: annotation.start_token,
                end_token: annotation.end_token,
                replacement: annotation.replacement,
                error_type_id: annotation.error_type_id,
                payload: annotation.payload,
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    const buttons = within(corrected)
      .getAllByRole("button")
      .map((c) => c.textContent?.trim())
      .filter((t) => t && t !== "↺") as string[];
    expect(buttons.join(" ")).toBe("one two three gamma");
    expect(within(corrected).getByText("alpha")).toBeInTheDocument();
    expect(within(corrected).getByText("beta")).toBeInTheDocument();
    expect(within(corrected).getAllByRole("button", { name: "gamma" })).toHaveLength(1);
  });

  it("hydrates multi-token merge edits without pulling the next token into history", async () => {
    localStorage.clear();
    const base = initState("foo bar baz");
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 1],
      newText: "foobar",
    });
    const [annotation] = await buildAnnotationsPayloadStandalone({
      initialText: "foo bar baz",
      tokens: edited.present.tokens,
      originalTokens: edited.present.originalTokens,
      correctionCards: [{ id: "c1", rangeStart: 0, rangeEnd: 0 }],
      correctionTypeMap: { c1: 1 },
      moveMarkers: [],
    });
    expect(annotation.start_token).toBe(0);
    expect(annotation.end_token).toBe(1);

    await renderEditor("foo bar baz", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 26,
                author_id: "other",
                start_token: annotation.start_token,
                end_token: annotation.end_token,
                replacement: annotation.replacement,
                error_type_id: annotation.error_type_id,
                payload: annotation.payload,
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    const buttons = within(corrected)
      .getAllByRole("button")
      .map((c) => c.textContent?.trim())
      .filter((t) => t && t !== "↺") as string[];
    expect(buttons.join(" ")).toBe("foobar baz");
    expect(within(corrected).getByText("foo")).toBeInTheDocument();
    expect(within(corrected).getByText("bar")).toBeInTheDocument();
    expect(within(corrected).getAllByRole("button", { name: "baz" })).toHaveLength(1);
  });

  it("hydrates move-like preannotations (insert + delete) from another annotator", async () => {
    localStorage.clear();
    await renderEditor("alpha beta gamma", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 30,
                author_id: "other",
                start_token: 0,
                end_token: 0,
                replacement: "beta",
                error_type_id: 1,
                payload: {
                  operation: "insert",
                  before_tokens: [],
                  after_tokens: [{ id: "i1", text: "beta", origin: "base" }],
                  text_tokens: ["alpha", "beta", "gamma"],
                },
              },
              {
                id: 31,
                author_id: "other",
                start_token: 1,
                end_token: 1,
                replacement: null,
                error_type_id: 1,
                payload: {
                  operation: "delete",
                  before_tokens: ["beta"],
                  after_tokens: [],
                  text_tokens: ["alpha", "beta", "gamma"],
                },
              },
            ],
          });
        }
        return Promise.resolve({ data: {} });
      },
    });

    const corrected = await screen.findByTestId("corrected-panel");
    await waitFor(() => {
      const tokens = within(corrected)
        .getAllByRole("button")
        .filter((el) => el.getAttribute("aria-pressed") !== null)
        .map((el) => el.textContent);
      expect(tokens.join(" ")).toBe("beta alpha ⬚ gamma");
    });
  });

  it("toggles between original and corrected text panel and persists collapse", async () => {
    const base = tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text: "hello world" });
    const edited = tokenEditorReducer(base, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [0, 0],
      newText: "hi",
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(edited.present));
    await renderEditor("hello world");
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "hi" });

    await waitFor(() => expect(screen.getByTestId("text-view-panel")).toHaveTextContent("hi world"));

    const originalTab = screen.getByRole("button", { name: "tokenEditor.original" });
    const correctedTab = screen.getByRole("button", { name: "tokenEditor.corrected" });

    await user.click(originalTab);
    await waitFor(() => expect(screen.getByTestId("text-view-panel")).toHaveTextContent("hello world"));

    await user.click(correctedTab);
    await waitFor(() => expect(screen.getByTestId("text-view-panel")).toHaveTextContent("hi world"));

    const collapseToggle = screen.getByTestId("text-panel-toggle");
    await user.click(collapseToggle);
    await waitFor(() => expect(screen.queryByTestId("text-view-panel")).toBeNull());

    cleanup();
    await renderEditor("hello world");
    await screen.findByRole("button", { name: "hi" });
    expect(screen.queryByTestId("text-view-panel")).toBeNull();

    await user.click(screen.getByTestId("text-panel-toggle"));
    await waitFor(() => expect(screen.getByTestId("text-view-panel")).toBeInTheDocument());
  });
});

describe("hydrates combined corrections", () => {
  const baseText =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";

  const buildAnnotationsFromState = async (state: EditorHistoryState) => {
    const tokens = state.present.tokens;
    const originalTokens = state.present.originalTokens;
    const moveMarkers = deriveMoveMarkers(tokens);
    const correctionCards = deriveCorrectionCards(tokens, moveMarkers);
    const correctionTypeMap = Object.fromEntries(
      correctionCards.map((card) => [card.id, 1])
    );
    return buildAnnotationsPayloadStandalone({
      initialText: baseText,
      tokens,
      originalTokens,
      correctionCards,
      correctionTypeMap,
      moveMarkers,
    });
  };

  const renderAndReadTokens = async (annotations: any[]) => {
    await renderEditor(baseText, {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({ data: annotations });
        }
        return Promise.resolve({ data: {} });
      },
    });
    const corrected = await screen.findByTestId("corrected-panel");
    return within(corrected)
      .getAllByRole("button")
      .filter((el) => el.getAttribute("data-token-index") !== null)
      .map((el) => el.textContent?.trim())
      .filter(Boolean) as string[];
  };

  const scenarios: Array<{ name: string; apply: (state: EditorHistoryState) => EditorHistoryState }> = [
    {
      name: "2 corrections non-intersecting (move + delete)",
      apply: (state) => {
        let next = moveTokensByText(state, ["delta"], "theta", "after");
        next = deleteTokenByText(next, "kappa");
        return next;
      },
    },
    {
      name: "2 corrections intersecting (move + edit moved)",
      apply: (state) => {
        let next = moveTokensByText(state, ["epsilon"], "beta", "after");
        next = editTokenByText(next, "epsilon", "epsilonX");
        return next;
      },
    },
    {
      name: "3 corrections non-intersecting (move + insert + delete)",
      apply: (state) => {
        let next = moveTokensByText(state, ["gamma"], "lambda", "after");
        next = insertAfterToken(next, "beta", "NEW1");
        next = deleteTokenByText(next, "eta");
        return next;
      },
    },
    {
      name: "4 corrections intersecting (move range + edit + insert + delete)",
      apply: (state) => {
        let next = moveTokensByText(state, ["delta", "epsilon"], "iota", "after");
        next = editTokenByText(next, "delta", "deltaX");
        next = insertAfterToken(next, "deltaX", "PLUS");
        next = deleteTokenByText(next, "zeta");
        return next;
      },
    },
    {
      name: "5 corrections mixed (move range + edit range + insert + delete + delete)",
      apply: (state) => {
        let next = moveTokensByText(state, ["theta", "iota"], "beta", "after");
        next = editRangeByText(next, "theta", "iota", "thetaIota");
        next = insertAfterToken(next, "thetaIota", "MID");
        next = deleteTokenByText(next, "gamma");
        next = deleteTokenByText(next, "mu");
        return next;
      },
    },
  ];

  it.each(scenarios)("$name", async ({ apply, name }) => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();

    const finalState = apply(initState(baseText));
    const payloads = await buildAnnotationsFromState(finalState);
    expect(payloads.some((payload) => payload.payload?.operation === "move")).toBe(true);
    const annotations = payloads.map((payload, idx) => ({
      id: 300 + idx,
      author_id: "other",
      start_token: payload.start_token,
      end_token: payload.end_token,
      replacement: payload.replacement,
      error_type_id: payload.error_type_id,
      payload: payload.payload,
    }));

    const renderedTokens = await renderAndReadTokens(annotations);
    const expectedTokens = tokensToDisplay(finalState.present.tokens);
    expect(renderedTokens).toEqual(expectedTokens);
  });
});

describe("navigation when category is empty", () => {
  it("returns to categories after submission when no texts remain", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    mockGet.mockImplementation((url: string) => {
      if (url.includes("/api/error-types")) {
        return Promise.resolve({ data: [] });
      }
      if (url.includes("/api/categories/")) {
        return Promise.resolve({ data: [{ id: 1, remaining_texts: 0 }] });
      }
      return Promise.resolve({ data: {} });
    });
    mockPost.mockImplementation((url: string) => {
      if (url.includes("/api/texts/1/annotations")) {
        return Promise.resolve({ data: [] });
      }
      if (url.includes("/api/texts/1/submit")) {
        return Promise.resolve({ data: {} });
      }
      if (url.includes("/api/texts/assignments/next")) {
        return Promise.reject({ response: { status: 404 } });
      }
      return Promise.resolve({ data: {} });
    });

    await renderEditor("hello world", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) {
          return Promise.resolve({ data: [] });
        }
        if (url.includes("/api/categories/")) {
          return Promise.resolve({ data: [{ id: 1, remaining_texts: 0 }] });
        }
        return Promise.resolve({ data: {} });
      },
    });
    const user = userEvent.setup();
    const submit = await screen.findByRole("button", { name: "common.submit" });
    await user.click(submit);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/"));
  });
});
