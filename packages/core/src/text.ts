export const wrapKorean = (text: string, maxCharsPerLine = 22): string[] => {
  if (!Number.isInteger(maxCharsPerLine) || maxCharsPerLine <= 0) {
    throw new RangeError("maxCharsPerLine must be a positive integer");
  }

  const words = text.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;

    if (current.length > 0 && candidate.length > maxCharsPerLine) {
      lines.push(current);

      if (lines.length === 2) {
        return lines;
      }

      current = word;
    } else {
      current = candidate;
    }
  }

  if (current.length > 0 && lines.length < 2) {
    lines.push(current);
  }

  return lines;
};
