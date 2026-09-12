import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildTextFromTokensWithBreaks,
  computeLineBreaksFromText,
  hydrateFromServerAnnotations,
  tokenizeToTokens
} from "./TokenEditorModel";

type ProductionRecord = {
  id: number;
  source: string;
  annotations: any[];
};

const inputPath = process.env.ANNOTATION_PARITY_INPUT;
const outputPath = process.env.ANNOTATION_PARITY_OUTPUT;

describe.skipIf(!inputPath || !outputPath)("production annotation rendering parity", () => {
  it("projects saved annotations through frontend hydration", () => {
    const records = JSON.parse(fs.readFileSync(inputPath!, "utf8")) as ProductionRecord[];
    const projected = records.map((record) => {
      const hydrated = hydrateFromServerAnnotations({
        items: record.annotations,
        initialText: record.source,
      });
      const targetTokens = hydrated
        ? hydrated.present.tokens
            .filter((token) => token.kind !== "empty")
            .map((token) => token.text)
        : tokenizeToTokens(record.source).map((token) => token.text);
      const target = hydrated
        ? buildTextFromTokensWithBreaks(hydrated.present.tokens, computeLineBreaksFromText(record.source))
        : buildTextFromTokensWithBreaks(tokenizeToTokens(record.source), computeLineBreaksFromText(record.source));
      return { id: record.id, target, target_tokens: targetTokens };
    });
    fs.writeFileSync(outputPath!, JSON.stringify(projected));
    expect(projected).toHaveLength(records.length);
  });
});
