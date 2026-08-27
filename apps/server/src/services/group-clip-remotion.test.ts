import {describe, expect, it} from "vitest";

import {CLIP_STYLE_TIMING, type ClipStyle} from "@travel-movie/schema";

import {buildGroupClipPlan, motionForStyle} from "./group-clip-remotion.js";

const storage = {publicUrl: (key: string) => `/assets/${key}`};

const plan = (style: ClipStyle, photos = 3) =>
  buildGroupClipPlan(
    {
      fps: 30,
      height: 720,
      photoKeys: Array.from({length: photos}, (_, index) => `render-assets/p${String(index)}.jpg`),
      style,
      width: 1280,
    },
    storage,
  );

describe("buildGroupClipPlan", () => {
  it("사진 한 장당 장면 하나를 만든다", () => {
    const built = plan("standard", 4);

    expect(built.scenes).toHaveLength(4);
    expect(built.scenes.every((scene) => scene.type === "photo")).toBe(true);
    expect(built.width).toBe(1280);
    expect(built.height).toBe(720);
  });

  it("첫 장면은 겹치지 않고 나머지는 교차 전환한다", () => {
    const built = plan("standard");

    expect(built.scenes[0]?.transitionIn).toEqual({overlapFrames: 0, type: "cut"});
    expect(built.scenes[1]?.transitionIn.type).toBe("crossfade");
    expect(built.scenes[1]?.transitionIn.overlapFrames).toBe(
      Math.round(CLIP_STYLE_TIMING.standard.crossfadeSec * 30),
    );
  });

  it("스타일에 따라 길이가 달라진다", () => {
    // 차분 > 기본 > 역동 순으로 길다.
    const durations = (["simple", "standard", "dynamic"] as const).map(
      (style) => plan(style).totalFrames,
    );

    expect(durations[0]).toBeGreaterThan(durations[1]!);
    expect(durations[1]).toBeGreaterThan(durations[2]!);
  });

  it("차분 스타일은 회전하지 않고 역동 스타일은 기울인다", () => {
    for (const scene of plan("simple").scenes) {
      expect(scene.motion?.fromRotateDeg).toBe(0);
      expect(scene.motion?.toRotateDeg).toBe(0);
    }
    expect(
      plan("dynamic").scenes.some(
        (scene) => scene.motion !== null && scene.motion.fromRotateDeg !== 0,
      ),
    ).toBe(true);
  });

  it("역동 스타일이 기본보다 크게 확대한다", () => {
    const zoomRange = (style: ClipStyle): number => {
      const motion = motionForStyle(style, 0);
      return Math.abs(motion.toScale - motion.fromScale);
    };

    expect(zoomRange("dynamic")).toBeGreaterThan(zoomRange("standard"));
    expect(zoomRange("standard")).toBeGreaterThan(zoomRange("simple"));
  });

  it("사진 순서대로 움직임을 돌려 쓴다", () => {
    const cycle = [0, 1, 2, 3, 4].map((index) => motionForStyle("standard", index).type);

    expect(cycle).toEqual(["zoom-in", "pan-right", "zoom-out", "pan-left", "zoom-in"]);
  });

  it("사진이 없으면 거부한다", () => {
    expect(() =>
      buildGroupClipPlan(
        {fps: 30, height: 720, photoKeys: [], style: "standard", width: 1280},
        storage,
      ),
    ).toThrow("사진이 최소 한 장");
  });
});
