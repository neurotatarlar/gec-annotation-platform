export type WhitespaceEditKind = "split" | "merge" | null;

export const isPlainWordToken = (value: string) => /^[\p{L}\p{N}]+$/u.test(value);

export const detectSingleWhitespaceEdit = (
  beforeText: string,
  afterText: string
): WhitespaceEditKind => {
  if (beforeText === afterText) return null;
  const isSingleSpaceInsert = (base: string, updated: string) => {
    if (updated.length !== base.length + 1) return false;
    let i = 0;
    let j = 0;
    let inserted = false;
    while (i < base.length && j < updated.length) {
      if (base[i] === updated[j]) {
        i += 1;
        j += 1;
        continue;
      }
      if (!inserted && updated[j] === " ") {
        inserted = true;
        j += 1;
        continue;
      }
      return false;
    }
    if (!inserted && j === updated.length - 1 && updated[j] === " ") {
      inserted = true;
      j += 1;
    }
    return inserted && i === base.length && j === updated.length;
  };
  if (isSingleSpaceInsert(beforeText, afterText)) return "split";
  if (isSingleSpaceInsert(afterText, beforeText)) return "merge";
  return null;
};

export const detectCapitalizationEdit = (
  beforeText: string,
  afterText: string,
  locale?: string
) => {
  if (!beforeText || !afterText) return false;
  if (beforeText.length !== afterText.length) return false;
  if (beforeText.slice(1) !== afterText.slice(1)) return false;
  const beforeFirst = beforeText[0];
  const upper = locale ? beforeFirst.toLocaleUpperCase(locale) : beforeFirst.toUpperCase();
  const lower = locale ? beforeFirst.toLocaleLowerCase(locale) : beforeFirst.toLowerCase();
  return beforeFirst === lower && afterText[0] === upper && afterText[0] !== beforeFirst;
};

export const detectSpellingEdit = (
  beforeText: string,
  afterText: string,
  maxDistance = 2
) => {
  if (beforeText === afterText) return false;
  if (Math.abs(beforeText.length - afterText.length) > maxDistance) return false;
  const a = beforeText;
  const b = afterText;
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1).fill(0);
  let next = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    next[0] = i;
    let rowMin = next[0];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = prev[j] + 1;
      const ins = next[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      const best = Math.min(del, ins, sub);
      next[j] = best;
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > maxDistance) return false;
    [prev, next] = [next, prev];
  }
  return prev[n] <= maxDistance;
};
