import {describe, expect, it} from "vitest";

import {RECOMMEND_MIN_COUNT, RECOMMEND_MIN_SCORE, recommendClipIds} from "./analyze-clips.js";

const clips = (...scores: number[]) =>
  scores.map((score, index) => ({id: `c${String(index)}`, score}));

describe("recommendClipIds", () => {
  it("기준 점수를 넘는 클립만 추천한다", () => {
    const chosen = recommendClipIds(clips(90, 80, 60, 55, 74));

    expect([...chosen].toSorted()).toEqual(["c0", "c1", "c4"]);
  });

  it("점수가 모두 낮으면 상위 몇 개는 추천해 영상이 비지 않게 한다", () => {
    const chosen = recommendClipIds(clips(60, 58, 55, 40));

    expect(chosen.size).toBe(RECOMMEND_MIN_COUNT);
    // 낮은 점수 중에서도 높은 순으로 고른다.
    expect([...chosen].toSorted()).toEqual(["c0", "c1", "c2"]);
  });

  it("클립이 최소 개수보다 적으면 전부 추천한다", () => {
    expect(recommendClipIds(clips(30, 20)).size).toBe(2);
  });

  it("기준 점수에 걸친 값은 포함한다", () => {
    expect(recommendClipIds(clips(RECOMMEND_MIN_SCORE, 10, 10, 10)).has("c0")).toBe(true);
  });

  it("빈 목록에서도 터지지 않는다", () => {
    expect(recommendClipIds([]).size).toBe(0);
  });
});
