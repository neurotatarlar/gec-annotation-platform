import { describe, expect, it } from "vitest";

import { groupErrorTypes, getErrorTypeSuperLabel, sortActiveErrorTypes } from "./errorTypes";

describe("getErrorTypeSuperLabel", () => {
  const base = {
    en_name: "Punctuation",
    tt_name: "Пунктуация",
    category_en: "Other",
    category_tt: "Башка",
    default_color: "#fff",
    default_hotkey: null,
    description: null,
    id: 1,
    is_active: true,
  } as any;

  it("returns category label in English for 'Other' grouping", () => {
    expect(getErrorTypeSuperLabel(base, "en")).toBe("Other");
  });

  it("returns localized category label for Tatar", () => {
    expect(getErrorTypeSuperLabel(base, "tt")).toBe("Башка");
  });
});

describe("sortActiveErrorTypes", () => {
  it("filters inactive types and sorts by category, order, name, then id", () => {
    const types = [
      { id: 4, en_name: "Beta", category_en: "B", sort_order: 1, is_active: true },
      { id: 3, en_name: "Zeta", category_en: "A", sort_order: 2, is_active: true },
      { id: 2, en_name: "Alpha", category_en: "A", sort_order: 2, is_active: true },
      { id: 1, en_name: "Hidden", category_en: "A", sort_order: 0, is_active: false },
      { id: 5, en_name: "Alpha", category_en: "A", sort_order: 2, is_active: true },
    ] as any;

    expect(sortActiveErrorTypes(types).map((type) => type.id)).toEqual([2, 5, 3, 4]);
  });
});

describe("groupErrorTypes", () => {
  it("groups by localized category label and preserves incoming order", () => {
    const types = [
      { id: 1, en_name: "A", category_en: "Grammar", category_tt: "Грамматика", is_active: true },
      { id: 2, en_name: "B", category_en: "Grammar", category_tt: "Грамматика", is_active: true },
      { id: 3, en_name: "C", category_en: "Punctuation", category_tt: "Пунктуация", is_active: true },
    ] as any;

    expect(groupErrorTypes(types, "tt", "Fallback")).toEqual([
      { label: "Грамматика", items: [types[0], types[1]] },
      { label: "Пунктуация", items: [types[2]] },
    ]);
  });

  it("uses category_en and then fallback label when localized category is missing", () => {
    const types = [
      { id: 1, en_name: "A", category_en: "Grammar", category_tt: "", is_active: true },
      { id: 2, en_name: "B", category_en: "", category_tt: "", is_active: true },
    ] as any;

    expect(groupErrorTypes(types, "tt", "Other")).toEqual([
      { label: "Grammar", items: [types[0]] },
      { label: "Other", items: [types[1]] },
    ]);
  });
});
