import { Token } from "./TokenEditorModel";

type TokenGroup = { tokens: Token[]; start: number; end: number };

export const buildTokenGroups = (tokenList: Token[]): TokenGroup[] => {
  const groups: TokenGroup[] = [];
  let idx = 0;
  while (idx < tokenList.length) {
    const current = tokenList[idx];
    if (current.groupId) {
      let end = idx;
      while (end + 1 < tokenList.length && tokenList[end + 1].groupId === current.groupId) {
        end += 1;
      }
      groups.push({ tokens: tokenList.slice(idx, end + 1), start: idx, end });
      idx = end + 1;
    } else {
      groups.push({ tokens: [current], start: idx, end: idx });
      idx += 1;
    }
  }
  return groups;
};

export type { TokenGroup };
