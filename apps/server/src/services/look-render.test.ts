import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import sharp from "sharp";
import {describe, expect, it} from "vitest";

import {renderPlanSchema, type LookPreset} from "@travel-movie/schema";

import {runtimeConfig, workspaceRoot} from "../config.js";
import {FfmpegService} from "./ffmpeg.js";
import {RemotionRenderService} from "./remotion.js";
import {LocalFsAdapter} from "../storage/local-fs-adapter.js";

/** 사진 한 장을 지정한 색감으로 한 번 렌더하는 최소 계획. */
const planFor = (look: LookPreset) =>
  renderPlanSchema.parse({
    audio: [],
    fps: 24,
    height: 360,
    scenes: [
      {
        assetKey: "render-assets/look-check.jpg",
        assetUrl: "/assets/render-assets/look-check.jpg",
        captions: [],
        durationInFrames: 24,
        id: "look-scene",
        look,
        mediaId: "m1",
        montage: null,
        motion: {fromScale: 1, fromX: 0, fromY: 0, toScale: 1, toX: 0, toY: 0, type: "static"},
        sourceAudio: "mute",
        startFrame: 0,
        transitionIn: {overlapFrames: 0, type: "cut"},
        trimStartFrame: null,
        type: "photo",
        visibleFrames: 24,
      },
    ],
    schemaVersion: 2,
    totalFrames: 24,
    width: 640,
  });

/** 프레임의 평균 채도. 0 이면 완전한 흑백이다. */
const meanSaturation = async (framePath: string): Promise<number> => {
  const {data, info} = await sharp(framePath).raw().toBuffer({resolveWithObject: true});
  let sum = 0;
  let pixels = 0;
  for (let index = 0; index + 2 < data.length; index += info.channels) {
    const r = data[index]!;
    const g = data[index + 1]!;
    const b = data[index + 2]!;
    sum += Math.max(r, g, b) - Math.min(r, g, b);
    pixels += 1;
  }
  return pixels === 0 ? 0 : sum / pixels;
};

describe("색감 필터", () => {
  // 렌더는 Chromium 과 ffmpeg 가 있어야 한다. 없으면 이 검증만 건너뛴다.
  const canRender =
    runtimeConfig.remotionBrowserExecutable !== null && runtimeConfig.ffmpegPath !== null;

  it.runIf(canRender)(
    "실제로 렌더된 mp4 픽셀까지 적용된다",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "autoveo-look-"));
      const storage = new LocalFsAdapter(root);
      const transcoder = new FfmpegService(runtimeConfig.ffmpegPath!);
      // 채도가 뚜렷한 빨간 이미지. 모노톤이 걸리면 채도가 0 이 되어야 한다.
      await storage.write(
        "render-assets/look-check.jpg",
        await sharp({
          create: {background: {b: 40, g: 30, r: 220}, channels: 3, height: 360, width: 640},
        })
          .jpeg({quality: 95})
          .toBuffer(),
      );

      const renderer = new RemotionRenderService({
        browserExecutable: runtimeConfig.remotionBrowserExecutable,
        remotionRoot: path.join(workspaceRoot, "remotion"),
        storage,
      });

      const saturation: Record<string, number> = {};
      for (const look of ["none", "mono"] as const) {
        const rendered = await renderer.render(planFor(look), {
          outputKey: `out-${look}.mp4`,
          planKey: `plans/look-${look}.json`,
        });
        const framePath = path.join(root, `frame-${look}.png`);
        await transcoder.run([
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          rendered.outputPath,
          "-frames:v",
          "1",
          framePath,
        ]);
        saturation[look] = await meanSaturation(framePath);
      }
      await rm(root, {force: true, maxRetries: 5, recursive: true, retryDelay: 200});

      expect(saturation.none!).toBeGreaterThan(60);
      expect(saturation.mono!).toBeLessThan(4);
    },
    900_000,
  );
});
