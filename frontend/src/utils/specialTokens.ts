const SPECIAL_TOKEN_SOURCES = [
  "\\+\\d[\\d()\\- ]*\\d",
  "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
  "(https?:\\/\\/[^\\s,;:!]+|www\\.[^\\s,;:!]+)",
];

const SPECIAL_TOKEN_FULL = SPECIAL_TOKEN_SOURCES.map((source) => new RegExp(`^${source}$`));

export const createSpecialTokenMatchers = (): Array<{ regex: RegExp }> =>
  SPECIAL_TOKEN_SOURCES.map((source) => ({
    regex: new RegExp(source, "y"),
  }));

export const isSpecialTokenText = (text: string): boolean => {
  const trimmed = text.replace(/[.,;:!?]+$/, "");
  if (!trimmed) return false;
  return SPECIAL_TOKEN_FULL.some((regex) => regex.test(trimmed));
};
