import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { expect, describe, it, vi, beforeEach } from "vitest";

import {
  createInitialHistoryState,
  EditorHistoryState,
  buildTextFromTokens,
  buildTextFromTokensWithBreaks,
  TokenEditor,
  tokenEditorReducer,
  tokenizeToTokens,
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
      queries: { retry: false },
    },
  });

const renderEditor = (initialText: string) => {
  mockGet.mockImplementation((url: string) => {
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

const initState = (text = "hello world"): EditorHistoryState =>
  tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text });

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

  it("buildTextFromTokens skips empty placeholders", () => {
    const tokens = [
      { id: "1", text: "hello", kind: "word", selected: false },
      { id: "2", text: "", kind: "empty", selected: false },
      { id: "3", text: "world", kind: "word", selected: false },
    ] as any;
    expect(buildTextFromTokens(tokens)).toBe("hello world");
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
});

describe("TokenEditor view toggles", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
  });

  it.skip("toggles between original and corrected text panel and persists collapse", () => {});
});
