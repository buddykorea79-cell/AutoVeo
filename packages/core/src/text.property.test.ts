import fc from "fast-check";
import {describe, expect, it} from "vitest";

import {wrapKorean} from "./text.js";

const PROPERTY_RUNS = 1_200;
const wordArbitrary = fc.constantFrom(
  "교토",
  "아침",
  "산책",
  "기차에서",
  "만난",
  "풍경",
  "아주긴하나의어절입니다",
  "travel",
  "2026",
);

describe("wrapKorean properties", () => {
  it("keeps whole words in source order and emits at most two lines", () => {
    console.info(`PROPERTY_TEST wrapKorean runs=${PROPERTY_RUNS}`);

    fc.assert(
      fc.property(
        fc.array(wordArbitrary, {maxLength: 40}),
        fc.integer({min: 1, max: 24}),
        (sourceWords, maxCharsPerLine) => {
          const lines = wrapKorean(sourceWords.join("   "), maxCharsPerLine);
          const outputWords = lines.join(" ").split(/\s+/u).filter(Boolean);

          expect(lines.length).toBeLessThanOrEqual(2);
          expect(outputWords).toEqual(sourceWords.slice(0, outputWords.length));

          for (const line of lines) {
            const words = line.split(" ");
            if (line.length > maxCharsPerLine) {
              expect(words).toHaveLength(1);
              expect(words[0]?.length).toBeGreaterThan(maxCharsPerLine);
            }
          }
        },
      ),
      {numRuns: PROPERTY_RUNS},
    );
  });
});
