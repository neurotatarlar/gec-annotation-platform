import { describe, expect, it } from "vitest";

import { buildMoveLine, findRectEdgePoint, RectLike } from "./TokenEditorMoveLine";

const rect = (left: number, top: number, width: number, height: number): RectLike => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

describe("TokenEditorMoveLine", () => {
  it("builds a horizontal connector between nearest rectangle edges", () => {
    expect(
      buildMoveLine(
        rect(10, 5, 200, 100),
        rect(20, 20, 20, 20),
        rect(120, 20, 20, 20)
      )
    ).toEqual({ x1: 30, y1: 25, x2: 110, y2: 25 });
  });

  it("builds a vertical connector between nearest rectangle edges", () => {
    expect(
      buildMoveLine(
        rect(10, 5, 200, 200),
        rect(60, 20, 20, 20),
        rect(60, 120, 20, 20)
      )
    ).toEqual({ x1: 60, y1: 35, x2: 60, y2: 115 });
  });

  it("finds the closest diagonal edge intersection", () => {
    expect(
      findRectEdgePoint(
        { x: 20, y: 20 },
        { x: 100, y: 60 },
        rect(10, 10, 20, 20)
      )
    ).toEqual({ x: 30, y: 25 });
  });

  it("falls back to the source point when rectangles overlap at the same center", () => {
    expect(
      findRectEdgePoint(
        { x: 20, y: 20 },
        { x: 20, y: 20 },
        rect(10, 10, 20, 20)
      )
    ).toEqual({ x: 20, y: 20 });
  });
});
