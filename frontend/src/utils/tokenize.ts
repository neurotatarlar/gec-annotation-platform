/**
 * Tokenization helpers for splitting text into editor tokens.
 */
const punctuationRegex = /([.,!?;:()\[\]{}"'«»“”<>…])/g;

export const tokenizeText = (text: string): string[] => {
  if (!text) {
    return [];
  }
  const trimmed = text.trim();
  if (trimmed === "<EMPTY>") {
    return ["<EMPTY>"];
  }
  const normalized = text.replace(punctuationRegex, " $1 ");
  return normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
};
