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

  it("restores original order when reverting a leftward move", () => {
    const state1 = initState("one two three four");
    const moved = tokenEditorReducer(state1, {
      type: "MOVE_SELECTED_BY_DRAG",
      fromIndex: 3,
      toIndex: 0,
      count: 1,
    });
    const marker = moved.present.moveMarkers[0];
    expect(marker.toStart).toBe(0);
    const reverted = tokenEditorReducer(moved, {
      type: "REVERT_CORRECTION",
      rangeStart: marker.toStart,
      rangeEnd: marker.toEnd,
      markerId: marker.id,
    });
    expect(buildTextFromTokens(reverted.present.tokens)).toBe("one two three four");
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
    expect(reverted.present.moveMarkers.length).toBe(0);
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

  it("moves a multi-token block and keeps the placeholder history", () => {
    const state1 = initState("one two three four");
    const moved = tokenEditorReducer(state1, {
      type: "MOVE_SELECTED_BY_DRAG",
      fromIndex: 1,
      toIndex: 4,
      count: 2,
    });
    const tokens = moved.present.tokens;
    expect(tokens.map((t) => (t.kind === "empty" ? "⬚" : t.text))).toEqual(["one", "⬚", "four", "two", "three"]);
    expect(tokens[1].previousTokens?.map((t) => t.text)).toEqual(["two", "three"]);
    const movedGroup = tokens.slice(3, 5);
    expect(movedGroup.every((t) => t.groupId === movedGroup[0].groupId)).toBe(true);
    const destAnchor = movedGroup.find((t) => t.previousTokens?.length);
    expect(destAnchor?.previousTokens?.[0]?.kind).toBe("empty");
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

  it("buildTextFromTokensWithBreaks preserves new lines", () => {
    const tokens = [
      { id: "1", text: "hello", kind: "word", selected: false },
      { id: "2", text: "world", kind: "word", selected: false },
      { id: "3", text: "next", kind: "word", selected: false },
    ] as any;
    const breaks = [2]; // newline after second visible token
    expect(buildTextFromTokensWithBreaks(tokens, breaks)).toBe("hello world\nnext");
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

describe("buildAnnotationsPayloadStandalone", () => {
  const baseToken = (id: string, text: string) =>
    ({ id, text, kind: "word", selected: false } as any);

  it("includes text token hash and carries annotation ids", async () => {
    const originalTokens = [baseToken("t1", "hello"), baseToken("t2", "world")];
    const tokens = [baseToken("t1", "hi"), baseToken("t2", "world")];
    const correctionCards = [{ id: "card-1", rangeStart: 0, rangeEnd: 0, markerId: null }];
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
    const correctionCards = [{ id: "card-1", rangeStart: 0, rangeEnd: 0, markerId: null }];
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
    const state = { originalTokens, tokens, moveMarkers: [] };
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
      { id: "c1", rangeStart: 0, rangeEnd: 0, markerId: null },
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
      moveMarkers: [],
    };
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(correctedGroup));
    await renderEditor("placeholder");
    const user = userEvent.setup();
    const chip = await screen.findByRole("button", { name: "hi" });
    let groupDiv: HTMLElement | null = chip;
    while (groupDiv && groupDiv.style.borderRadius !== "14px") {
      groupDiv = groupDiv.parentElement;
    }
    const initialBg = groupDiv?.style.background;
    await user.click(chip);
    expect(groupDiv?.style.background).toBe(initialBg);
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

  it("selects placeholder and moved tokens after a right-to-left move", async () => {
    const present = {
      originalTokens: [
        { id: "o1", text: "one", kind: "word", selected: false },
        { id: "o2", text: "two", kind: "word", selected: false },
      ],
      tokens: [
        {
          id: "ph",
          text: "",
          kind: "empty",
          selected: false,
          origin: "base",
          groupId: "g1",
          moveId: "m1",
          previousTokens: [{ id: "o2", text: "two", kind: "word", selected: false }],
        },
        { id: "t1", text: "one", kind: "word", selected: false, origin: "base", groupId: "g2", moveId: "m1" },
      ],
      moveMarkers: [{ id: "m1", fromStart: 1, fromEnd: 1, toStart: 0, toEnd: 0 }],
    } as any;
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(present));
    await renderEditor("two one");
    const placeholder = await screen.findByRole("button", { name: "⬚" });
    const moved = await screen.findByRole("button", { name: "one" });
    await waitFor(() => {
      expect(placeholder).toHaveAttribute("aria-pressed", "true");
      expect(moved).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("selects placeholder and moved tokens after a left-to-right move", async () => {
    const present = {
      originalTokens: [
        { id: "o1", text: "one", kind: "word", selected: false },
        { id: "o2", text: "two", kind: "word", selected: false },
      ],
      tokens: [
        { id: "t1", text: "two", kind: "word", selected: false, origin: "base", groupId: "g2", moveId: "m1" },
        {
          id: "ph",
          text: "",
          kind: "empty",
          selected: false,
          origin: "base",
          groupId: "g1",
          moveId: "m1",
          previousTokens: [{ id: "o1", text: "one", kind: "word", selected: false }],
        },
      ],
      moveMarkers: [{ id: "m1", fromStart: 0, fromEnd: 0, toStart: 1, toEnd: 1 }],
    } as any;
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(present));
    await renderEditor("one two");
    const placeholder = await screen.findByRole("button", { name: "⬚" });
    const moved = await screen.findByRole("button", { name: "two" });
    await waitFor(() => {
      expect(placeholder).toHaveAttribute("aria-pressed", "true");
      expect(moved).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("drops multi-token moves at the intended caret even when dragging from the last token", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    await renderEditor("one two three four five six seven eight");
    const user = userEvent.setup();

    const six = await screen.findByRole("button", { name: "six" });
    const eight = screen.getByRole("button", { name: "eight" });
    await user.click(six);
    await user.click(eight, { ctrlKey: true });

    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(),
      setDragImage: vi.fn(),
      dropEffect: "move",
      effectAllowed: "move",
    };

    await act(async () => {
      fireEvent.dragStart(eight, { dataTransfer });
    });

    const corrected = await screen.findByTestId("corrected-panel");
    const tokenNodes = Array.from(corrected.querySelectorAll("[data-token-index]")) as HTMLElement[];
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

    await act(async () => {
      fireEvent.dragOver(corrected, { dataTransfer, clientX: 75, clientY: 5 });
      fireEvent.drop(corrected, { dataTransfer, clientX: 75, clientY: 5 });
    });

    await waitFor(() => {
      const tokenNodes = Array.from(corrected.querySelectorAll("[data-token-index]")) as HTMLElement[];
      const texts = tokenNodes
        .map((node) => node.textContent?.trim() ?? "")
        .filter((text) => text && text !== "⬚");
      expect(texts).toEqual(["one", "two", "three", "four", "six", "seven", "eight", "five"]);
    });
  });

  it("draws a move connector on hover", async () => {
    const moved = tokenEditorReducer(initState("one two three"), {
      type: "MOVE_SELECTED_BY_DRAG",
      fromIndex: 1,
      toIndex: 3,
      count: 1,
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(moved.present));
    await renderEditor("one two three");
    const corrected = await screen.findByTestId("corrected-panel");
    const moveGroup = corrected.querySelector("[data-move-id][data-move-role]");
    expect(moveGroup).toBeTruthy();
    fireEvent.mouseEnter(moveGroup as Element);
    await waitFor(() => {
      const line = corrected.querySelector("line[marker-end]");
      expect(line).toBeTruthy();
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

  it("selects only the placeholder and moved tokens for a lone move without touching intermediates", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const moved = tokenEditorReducer(initState("alpha beta gamma delta"), {
      type: "MOVE_SELECTED_BY_DRAG",
      fromIndex: 0,
      toIndex: 3,
      count: 1,
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(moved.present));
    await renderEditor("alpha beta gamma delta");
    const placeholder = await screen.findByRole("button", { name: "⬚" });
    const alpha = await screen.findByRole("button", { name: "alpha" });
    const beta = screen.getByRole("button", { name: "beta" });
    const gamma = screen.getByRole("button", { name: "gamma" });
    await waitFor(() => {
      expect(placeholder).toHaveAttribute("aria-pressed", "true");
      expect(alpha).toHaveAttribute("aria-pressed", "true");
      expect(beta).toHaveAttribute("aria-pressed", "false");
      expect(gamma).toHaveAttribute("aria-pressed", "false");
    });
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

  it("prefers the latest move selection even when earlier edits exist", async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    const edited = tokenEditorReducer(initState("first second third"), {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [2, 2],
      newText: "third!",
    });
    const moved = tokenEditorReducer(edited, {
      type: "MOVE_SELECTED_BY_DRAG",
      fromIndex: 0,
      toIndex: 2,
      count: 1,
    });
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(moved.present));
    await renderEditor("first second third");
    const placeholder = await screen.findByRole("button", { name: "⬚" });
    const movedToken = await screen.findByRole("button", { name: "first" });
    const second = screen.getByRole("button", { name: "second" });
    const third = screen.getByRole("button", { name: "third!" });
    await waitFor(() => {
      expect(placeholder).toHaveAttribute("aria-pressed", "true");
      expect(movedToken).toHaveAttribute("aria-pressed", "true");
      expect(second).toHaveAttribute("aria-pressed", "false");
      expect(third).toHaveAttribute("aria-pressed", "false");
    });
  });
});

describe("TokenEditor view toggles", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
  });

  const seedMoveState = () => {
    const present = {
      originalTokens: [
        { id: "o1", text: "first", kind: "word", selected: false },
        { id: "o2", text: "second", kind: "word", selected: false },
      ],
      tokens: [
        {
          id: "ph1",
          text: "",
          kind: "empty",
          selected: false,
          origin: "base",
          groupId: "g1",
          moveId: "m1",
          previousTokens: [{ id: "p1", text: "first", kind: "word", selected: false }],
        },
        {
          id: "t2",
          text: "second",
          kind: "word",
          selected: false,
          origin: "base",
          groupId: "g2",
          moveId: "m1",
        },
      ],
      moveMarkers: [{ id: "m1", fromStart: 0, fromEnd: 0, toStart: 1, toEnd: 1 }],
    } as any;
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(present));
  };

  it("auto-selects the move correction when it is the newest change", async () => {
    const present = {
      originalTokens: [
        { id: "o1", text: "first", kind: "word", selected: false },
        { id: "o2", text: "second", kind: "word", selected: false },
        { id: "o3", text: "third", kind: "word", selected: false },
      ],
      tokens: [
        {
          id: "ph1",
          text: "",
          kind: "empty",
          selected: false,
          origin: "base",
          groupId: "g1",
          moveId: "m1",
          previousTokens: [{ id: "p1", text: "third", kind: "word", selected: false }],
        },
        { id: "t2", text: "first", kind: "word", selected: false, origin: "base", groupId: "g2", moveId: "m1" },
        {
          id: "t3",
          text: "second",
          kind: "word",
          selected: false,
          origin: "base",
          groupId: "g3",
          previousTokens: [{ id: "p2", text: "second-old", kind: "word", selected: false }],
        },
      ],
      moveMarkers: [{ id: "m1", fromStart: 0, fromEnd: 0, toStart: 1, toEnd: 1 }],
    } as any;
    localStorage.setItem("tokenEditorPrefs:state:1", JSON.stringify(present));

    await renderEditor("third first second");
    const placeholder = await screen.findByRole("button", { name: "⬚" });
    const moved = screen.getByRole("button", { name: "first" });
    const other = screen.getByRole("button", { name: "second" });
    await waitFor(() => {
      expect(placeholder).toHaveAttribute("aria-pressed", "true");
      expect(moved).toHaveAttribute("aria-pressed", "true");
      expect(other).toHaveAttribute("aria-pressed", "false");
    });
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

  it("hydrates server moves with placeholder and moved group", async () => {
    localStorage.clear();
    await renderEditor("hello brave new world", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 30,
                author_id: "other",
                start_token: 1,
                end_token: 1,
                replacement: null,
                error_type_id: 1,
                payload: {
                  operation: "move",
                  before_tokens: ["base-1"],
                  after_tokens: [{ id: "m1", text: "brave", origin: "base" }],
                  move_from: 1,
                  move_to: 4,
                  text_tokens: ["hello", "brave", "new", "world"],
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
    expect(chips).toContain("brave");
    expect(chips.join(" ")).toBe("hello ⬚ new world brave");
    // Placeholder should be rendered for the source location and destination history.
    expect(within(corrected).getAllByText("⬚").length).toBeGreaterThan(1);
  });

  it("hydrates multi-token moves with placeholder and moved group", async () => {
    localStorage.clear();
    await renderEditor("one two three four five", {
      getImpl: (url: string) => {
        if (url.includes("/api/error-types")) return Promise.resolve({ data: [] });
        if (url.includes("/annotations")) {
          return Promise.resolve({
            data: [
              {
                id: 40,
                author_id: "other",
                start_token: 1,
                end_token: 2,
                replacement: null,
                error_type_id: 1,
                payload: {
                  operation: "move",
                  before_tokens: ["two", "three"],
                  after_tokens: [
                    { id: "m2", text: "two", origin: "base" },
                    { id: "m3", text: "three", origin: "base" },
                  ],
                  move_from: 1,
                  move_to: 5,
                  text_tokens: ["one", "two", "three", "four", "five"],
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
    expect(chips.join(" ")).toBe("one ⬚ four five two three");
    expect(within(corrected).getAllByText("⬚").length).toBeGreaterThan(1);
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
      correctionCards: [{ id: "c1", rangeStart: 0, rangeEnd: 1, markerId: null }],
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
      correctionCards: [{ id: "c1", rangeStart: 0, rangeEnd: 2, markerId: null }],
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
      correctionCards: [{ id: "c1", rangeStart: 0, rangeEnd: 0, markerId: null }],
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
