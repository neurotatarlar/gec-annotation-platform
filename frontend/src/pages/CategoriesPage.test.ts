import { describe, expect, it } from "vitest";

import { splitUploadInput } from "./CategoriesPage";

describe("splitUploadInput", () => {
  it("splits texts by blank lines", () => {
    const input = "First line one\nFirst line two\n\nSecond text";
    expect(splitUploadInput(input)).toEqual(["First line one\nFirst line two", "Second text"]);
  });

  it("ignores leading/trailing blank lines and trims entries", () => {
    const input = "\n\n  First text  \n\n  Second text\n\n";
    expect(splitUploadInput(input)).toEqual(["First text", "Second text"]);
  });

  it("preserves single-text input without blank lines", () => {
    const input = "Single text only";
    expect(splitUploadInput(input)).toEqual(["Single text only"]);
  });

  it("handles multiple blank lines with spaces", () => {
    const input = "A\n\n   \nB\n\n\nC";
    expect(splitUploadInput(input)).toEqual(["A", "B", "C"]);
  });
});
