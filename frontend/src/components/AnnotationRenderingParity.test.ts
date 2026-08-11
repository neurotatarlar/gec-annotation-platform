import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { hydrateFromServerAnnotations } from "./TokenEditorModel";

type RenderingCase = {
  name: string;
  source: string;
  annotations: any[];
  expected_tokens: string[];
};

const fixturePath = path.resolve("../testdata/annotation_rendering_cases.json");
const cases = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as RenderingCase[];

describe("annotation rendering parity", () => {
  it.each(cases)("hydrates $name to the shared semantic token sequence", (testCase) => {
    const hydrated = hydrateFromServerAnnotations({
      items: testCase.annotations,
      initialText: testCase.source,
      currentUserId: "fixture-user",
    });

    expect(hydrated).not.toBeNull();
    const semanticTokens = (hydrated?.present.tokens ?? [])
      .filter((token) => token.kind !== "empty")
      .map((token) => token.text);
    expect(semanticTokens).toEqual(testCase.expected_tokens);
  });
});
