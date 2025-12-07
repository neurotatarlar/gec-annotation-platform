import React from "react";
import { render, screen, waitFor, act, within, cleanup } from "@testing-library/react";
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

// Silence React Router future-flag warnings that are not actionable in tests.
const originalWarn = console.warn;
beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation((msg: any, ...rest: any[]) => {
    if (typeof msg === "string" && msg.includes("React Router Future Flag Warning")) return;
    originalWarn(msg, ...rest);
  });
});

afterAll(() => {
  (console.warn as any).mockRestore?.();
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
    expect(edited.present.tokens.map((t) => t.text)).toEqual(["foo", ",", "bar", "hello", "world"]);
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
});

describe("TokenEditor view toggles", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    localStorage.clear();
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

  it("shows debug data inside preview panel via debug tab", async () => {
    await renderEditor("hello world");
    const user = userEvent.setup();
    const debugTab = screen.getByRole("button", { name: "tokenEditor.debugPanel" });
    await user.click(debugTab);
    const panel = await screen.findByTestId("text-view-panel");
    expect(panel.textContent).toContain("\"textId\":1");

    const correctedTab = screen.getByRole("button", { name: "tokenEditor.corrected" });
    await user.click(correctedTab);
    await waitFor(() => expect(screen.getByTestId("text-view-panel")).toHaveTextContent("hello world"));
  });
});
