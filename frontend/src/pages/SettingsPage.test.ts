import { describe, expect, it } from "vitest";
import { collectCategoryOptions } from "./SettingsPage";
import type { ErrorType } from "../types";

describe("collectCategoryOptions", () => {
  const baseTypes: ErrorType[] = [
    {
      id: 1,
      category_en: "Grammar",
      category_tt: "Грамматика",
      en_name: "Case",
      tt_name: "Г/Килеш",
      default_color: "#fff",
      is_active: true,
      default_hotkey: null,
      description: "",
    },
    {
      id: 2,
      category_en: "WordError",
      category_tt: "Сүз",
      en_name: "Spelling",
      tt_name: "Сүз",
      default_color: "#000",
      is_active: true,
      default_hotkey: null,
      description: "",
    },
  ];

  it("merges categories from types, drafts, and pending new, removing duplicates and sorting", () => {
    const drafts = {
      1: {
        description: "",
        default_color: "#fff",
        default_hotkey: "",
        category_en: "Fluency",
        category_tt: "Шомалык",
        en_name: "",
        tt_name: "",
        is_active: true,
      },
    };
    const pending = [
      {
        description: "",
        default_color: "#aaa",
        default_hotkey: "",
        category_en: "WordError",
        category_tt: "Диалект",
        en_name: "",
        tt_name: "",
        is_active: true,
      },
    ];

    const ttOptions = collectCategoryOptions(baseTypes, drafts, pending, "category_tt");
    expect(ttOptions).toEqual(["Грамматика", "Диалект", "Сүз", "Шомалык"]);

    const enOptions = collectCategoryOptions(baseTypes, drafts, pending, "category_en");
    expect(enOptions).toEqual(["Fluency", "Grammar", "WordError"]);
  });

  it("ignores empty or undefined categories", () => {
    const drafts = {
      2: {
        description: "",
        default_color: "#000",
        default_hotkey: "",
        category_en: "",
        category_tt: undefined,
        en_name: "",
        tt_name: "",
        is_active: true,
      },
    };

    const pending: any[] = [
      {
        description: "",
        default_color: "#123",
        default_hotkey: "",
        category_en: null,
        category_tt: "",
        en_name: "",
        tt_name: "",
        is_active: true,
      },
    ];

    const ttOptions = collectCategoryOptions(baseTypes, drafts, pending, "category_tt");
    expect(ttOptions).toEqual(["Грамматика", "Сүз"]);
  });
});
