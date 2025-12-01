import { describe, expect, it } from "vitest";

import { getErrorTypeSuperLabel } from "./errorTypes";

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
