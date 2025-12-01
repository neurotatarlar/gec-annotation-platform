import { describe, expect, it } from "vitest";

import { parseUploadJson, mergeUploadEntries, type UploadEntry } from "./CategoriesPage";

describe("parseUploadJson", () => {
  it("parses string or object items", () => {
    const input = JSON.stringify([
      "hello",
      { id: 123, text: "world" },
      { text: "skip me? " },
    ]);
    expect(parseUploadJson(input)).toEqual([
      { text: "hello" },
      { id: "123", text: "world" },
      { text: "skip me? " },
    ]);
  });

  it("throws on invalid json", () => {
    expect(() => parseUploadJson("not json")).toThrow();
  });

  it("throws on non-array json", () => {
    expect(() => parseUploadJson('{"text":"x"}')).toThrow();
  });

  it("throws on invalid item types", () => {
    const bad = JSON.stringify([123]);
    expect(() => parseUploadJson(bad)).toThrow();
  });
});

describe("mergeUploadEntries", () => {
  it("deduplicates by id when present, otherwise by text", () => {
    const merged = mergeUploadEntries([
      [
        { id: "a", text: "one" },
        { text: "two" },
      ],
      [
        { id: "a", text: "duplicate" },
        { text: "two" },
        { text: "three" },
      ],
    ] as UploadEntry[][]);
    expect(merged).toEqual([
      { id: "a", text: "one" },
      { text: "two" },
      { text: "three" },
    ]);
  });
});
