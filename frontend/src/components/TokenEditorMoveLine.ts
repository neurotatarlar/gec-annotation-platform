/**
 * Geometry helpers for move-hover connector lines in the token editor.
 */

export type Point = { x: number; y: number };

export type RectLike = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export type MoveLine = { x1: number; y1: number; x2: number; y2: number };

export const rectCenter = (rect: RectLike): Point => ({
  x: rect.left + rect.width / 2,
  y: rect.top + rect.height / 2,
});

export const findRectEdgePoint = (from: Point, to: Point, rect: RectLike): Point => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const candidates: Array<{ t: number; x: number; y: number }> = [];
  if (dx !== 0) {
    const tLeft = (rect.left - from.x) / dx;
    const yLeft = from.y + tLeft * dy;
    if (tLeft > 0 && tLeft < 1 && yLeft >= rect.top && yLeft <= rect.bottom) {
      candidates.push({ t: tLeft, x: rect.left, y: yLeft });
    }
    const tRight = (rect.right - from.x) / dx;
    const yRight = from.y + tRight * dy;
    if (tRight > 0 && tRight < 1 && yRight >= rect.top && yRight <= rect.bottom) {
      candidates.push({ t: tRight, x: rect.right, y: yRight });
    }
  }
  if (dy !== 0) {
    const tTop = (rect.top - from.y) / dy;
    const xTop = from.x + tTop * dx;
    if (tTop > 0 && tTop < 1 && xTop >= rect.left && xTop <= rect.right) {
      candidates.push({ t: tTop, x: xTop, y: rect.top });
    }
    const tBottom = (rect.bottom - from.y) / dy;
    const xBottom = from.x + tBottom * dx;
    if (tBottom > 0 && tBottom < 1 && xBottom >= rect.left && xBottom <= rect.right) {
      candidates.push({ t: tBottom, x: xBottom, y: rect.bottom });
    }
  }
  if (!candidates.length) return from;
  const closest = candidates.reduce((a, b) => (a.t < b.t ? a : b));
  return { x: closest.x, y: closest.y };
};

export const buildMoveLine = (
  containerRect: RectLike,
  sourceRect: RectLike,
  destinationRect: RectLike
): MoveLine => {
  const sourceCenter = rectCenter(sourceRect);
  const destinationCenter = rectCenter(destinationRect);
  const sourceEdge = findRectEdgePoint(sourceCenter, destinationCenter, sourceRect);
  const destinationEdge = findRectEdgePoint(destinationCenter, sourceCenter, destinationRect);
  return {
    x1: sourceEdge.x - containerRect.left,
    y1: sourceEdge.y - containerRect.top,
    x2: destinationEdge.x - containerRect.left,
    y2: destinationEdge.y - containerRect.top,
  };
};
