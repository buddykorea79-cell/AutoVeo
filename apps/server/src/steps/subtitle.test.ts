import {describe, expect, it} from "vitest";

import type {Project} from "@travel-movie/schema";

import {planSubtitles} from "./subtitle.js";

const chapter = (index: number, caption: {source: "ai" | "user"; text: string} | null) => ({
  caption:
    caption === null
      ? null
      : {kind: "scene-caption" as const, source: caption.source, text: caption.text},
  dateLocal: "2026-05-01",
  generatedVideo: null,
  id: `c${String(index)}`,
  mood: "calm" as const,
  musicDirection: {energy: 0.35, mood: "calm" as const},
  place: null,
  scenes: [
    {
      caption: null,
      durationSec: 6,
      effect: null,
      id: `s${String(index)}`,
      importance: 0.5 + index * 0.05,
      locked: false,
      look: "none" as const,
      mediaId: `m${String(index)}`,
      motion: "static" as const,
      remotionPrompt: null,
      role: "filler" as const,
      sourceAudio: "mute" as const,
      transitionIn: "crossfade" as const,
      trim: null,
    },
  ],
  title: `클립 ${String(index)}`,
});

const project = (captions: ({source: "ai" | "user"; text: string} | null)[]): Project =>
  ({
    budget: {
      photoBaseSec: 3.6,
      photoMaxSec: 6,
      targetDurationSec: 6 * captions.length,
      targetSceneCount: captions.length,
      videoMaxSec: 30,
    },
    chapters: captions.map((caption, index) => chapter(index, caption)),
    id: "p",
    output: {aspect: "16:9" as const, fps: 30, resolution: "1080p" as const},
    schemaVersion: 2,
    style: "cinematic-travel" as const,
    title: "테스트",
  }) as unknown as Project;

describe("planSubtitles", () => {
  it("자막을 넣은 클립은 하나도 빠뜨리지 않는다", () => {
    // 예전에는 60% 상한 때문에 세 개 중 한 개만 남았다.
    const manifest = planSubtitles(
      project([
        {source: "ai", text: "첫 장면"},
        {source: "ai", text: "둘째 장면"},
        {source: "ai", text: "셋째 장면"},
      ]),
    );

    expect(manifest.proposals).toHaveLength(3);
    expect(manifest.proposals.map((proposal) => proposal.text)).toEqual([
      "첫 장면",
      "둘째 장면",
      "셋째 장면",
    ]);
  });

  it("AI 자막과 직접 쓴 자막을 똑같이 다룬다", () => {
    const manifest = planSubtitles(
      project([
        {source: "user", text: "직접 쓴 자막"},
        {source: "ai", text: "AI 자막"},
      ]),
    );

    expect(manifest.proposals).toHaveLength(2);
  });

  it("자막이 없는 클립은 건너뛴다", () => {
    const manifest = planSubtitles(project([{source: "user", text: "하나만"}, null, null]));

    expect(manifest.proposals).toHaveLength(1);
    expect(manifest.proposals[0]?.chapterId).toBe("c0");
  });

  it("자막이 하나도 없으면 알려 준다", () => {
    const manifest = planSubtitles(project([null, null]));

    expect(manifest.proposals).toHaveLength(0);
    expect(manifest.warnings.map((warning) => warning.code)).toContain("below-target-coverage");
  });

  it("22자를 넘으면 두 줄로 나눈다", () => {
    const manifest = planSubtitles(
      project([{source: "user", text: "제주 바닷가를 따라 걷는 조용한 아침 산책길"}]),
    );

    expect(manifest.proposals[0]?.lines.length).toBeLessThanOrEqual(2);
    for (const line of manifest.proposals[0]?.lines ?? []) {
      expect(line.length).toBeLessThanOrEqual(22);
    }
  });
});
