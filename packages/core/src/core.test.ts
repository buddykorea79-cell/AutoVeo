import {describe, expect, it} from "vitest";

import {computeSceneBudget} from "./budget.js";
import {
  clusterByTimeAndHash,
  dhashDistance,
  dhashFromGrayscale,
  percentileRanks,
} from "./fingerprint.js";
import {layoutAudioSegments, layoutMontage, planCaptionTiming} from "./timeline.js";

describe("layoutMontage", () => {
  it("lays out unique images with integer overlaps that end on the scene boundary", () => {
    const items = layoutMontage(["a", "b", "c"], 120, 30);
    expect(items).toEqual([
      {
        durationInFrames: 44,
        fadeInFrames: 0,
        fadeOutFrames: 5,
        sourceId: "a",
        startFrame: 0,
      },
      {
        durationInFrames: 43,
        fadeInFrames: 5,
        fadeOutFrames: 5,
        sourceId: "b",
        startFrame: 39,
      },
      {
        durationInFrames: 43,
        fadeInFrames: 5,
        fadeOutFrames: 0,
        sourceId: "c",
        startFrame: 77,
      },
    ]);
    expect(items.at(-1)!.startFrame + items.at(-1)!.durationInFrames).toBe(120);
  });
});

describe("layoutAudioSegments", () => {
  it("uses integer chapter-boundary frames and bounded fades", () => {
    expect(
      layoutAudioSegments(
        [
          {startFrame: 0, value: "calm"},
          {startFrame: 1800, value: "upbeat"},
        ],
        3600,
        30,
      ),
    ).toEqual([
      {
        durationInFrames: 1800,
        fadeInFrames: 45,
        fadeOutFrames: 45,
        startFrame: 0,
        value: "calm",
      },
      {
        durationInFrames: 1800,
        fadeInFrames: 45,
        fadeOutFrames: 45,
        startFrame: 1800,
        value: "upbeat",
      },
    ]);
  });
});

describe("planCaptionTiming", () => {
  it("places readable captions inside the scene", () => {
    expect(planCaptionTiming({startFrame: 100, durationInFrames: 90}, 30)).toEqual({
      durationInFrames: 63,
      startFrame: 112,
    });
    expect(planCaptionTiming({startFrame: 0, durationInFrames: 60}, 30)).toBeNull();
  });
});

describe("dhashDistance", () => {
  it("counts differing bits", () => {
    expect(dhashDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(dhashDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(dhashDistance("0000000000000000", "0000000000000003")).toBe(2);
  });

  it("builds a 64-bit hash from a 9 by 8 grayscale grid", () => {
    const increasingRows = Uint8Array.from(
      Array.from({length: 8}, () => [0, 1, 2, 3, 4, 5, 6, 7, 8]).flat(),
    );
    expect(dhashFromGrayscale(increasingRows)).toBe("ffffffffffffffff");
  });
});

describe("percentileRanks", () => {
  it("normalizes tied project-relative values to average ranks", () => {
    expect(percentileRanks([10, 20, 20, 40])).toEqual([0, 0.5, 0.5, 1]);
    expect(percentileRanks([10])).toEqual([1]);
  });
});

describe("clusterByTimeAndHash", () => {
  it("clusters only adjacent items close in time and hash", () => {
    const clusters = clusterByTimeAndHash(
      [
        {capturedAtLocal: "2026-05-12T10:00:06", dhash: "ffffffffffffffff", id: "c"},
        {capturedAtLocal: "2026-05-12T10:00:00", dhash: "0000000000000000", id: "a"},
        {capturedAtLocal: "2026-05-12T10:00:04", dhash: "0000000000000001", id: "b"},
      ],
      {maxGapSec: 5, maxHamming: 2},
    );

    expect(clusters.map((cluster) => cluster.map(({id}) => id))).toEqual([["a", "b"], ["c"]]);
  });

  it("splits identical hashes when the adjacent time gap is 60 seconds", () => {
    const clusters = clusterByTimeAndHash(
      [
        {capturedAtLocal: "2026-05-12T10:00:00", dhash: "aaaaaaaaaaaaaaaa", id: "a"},
        {capturedAtLocal: "2026-05-12T10:01:00", dhash: "aaaaaaaaaaaaaaaa", id: "b"},
      ],
      {maxGapSec: 45, maxHamming: 10},
    );
    expect(clusters).toHaveLength(2);
  });
});

describe("computeSceneBudget", () => {
  it("uses effective scene duration before directing", () => {
    expect(computeSceneBudget(300)).toEqual({
      photoBaseSec: 3.6,
      photoMaxSec: 6,
      targetDurationSec: 300,
      targetSceneCount: 91,
      videoMaxSec: 8,
    });
  });
});
