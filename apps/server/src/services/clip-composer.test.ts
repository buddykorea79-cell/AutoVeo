import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {ffmpegPath, ffprobePath} from "ffmpeg-ffprobe-static";
import {afterEach, describe, expect, it} from "vitest";

import {
  buildGroupClipFilter,
  buildVideoSegmentFilter,
  composeVideoSegmentClip,
  groupClipDurationForInput,
  motionForIndex,
  type ComposeGroupClipInput,
} from "./clip-composer.js";
import {FfmpegService} from "./ffmpeg.js";
import {FfprobeService} from "./ffprobe.js";
import {LocalFsAdapter} from "../storage/local-fs-adapter.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, {force: true, maxRetries: 5, recursive: true, retryDelay: 100})),
  );
});

const input = (photoCount: number): ComposeGroupClipInput => ({
  crossfadeSec: 0.5,
  fps: 30,
  height: 720,
  perPhotoSec: 2.6,
  photoPaths: Array.from({length: photoCount}, (_, index) => `C:/trip/p${String(index)}.jpg`),
  width: 1280,
});

describe("buildGroupClipFilter", () => {
  it("emits one motion stage per photo at the output size", () => {
    const filter = buildGroupClipFilter(input(3));

    expect(filter.match(/zoompan=/gu)).toHaveLength(3);
    expect(filter.match(/s=1280x720/gu)).toHaveLength(3);
    expect(filter.match(/fps=30/gu)).toHaveLength(3);
    // 확대할 때 계단 현상이 생기지 않도록 두 배로 올린 뒤 자른다.
    expect(filter).toContain("scale=2560:1440:force_original_aspect_ratio=increase");
  });

  it("chains crossfades so the offsets match the accumulated length", () => {
    const filter = buildGroupClipFilter(input(3));

    // 클립 한 장은 78프레임 = 2.6초. 첫 전환은 2.6-0.5, 다음은 (2.6*2-0.5)-0.5.
    expect(filter).toContain("xfade=transition=fade:duration=0.500:offset=2.100[x1]");
    expect(filter).toContain("xfade=transition=fade:duration=0.500:offset=4.200[out]");
  });

  it("skips the crossfade chain for a single photo", () => {
    const filter = buildGroupClipFilter(input(1));

    expect(filter).not.toContain("xfade");
    expect(filter.endsWith("[v0]null[out]")).toBe(true);
  });

  it("rejects an empty group", () => {
    expect(() => buildGroupClipFilter(input(0))).toThrow("사진이 최소 한 장");
  });

  it("computes the clip length from whole frames", () => {
    expect(groupClipDurationForInput(input(1))).toBeCloseTo(2.6, 5);
    expect(groupClipDurationForInput(input(3))).toBeCloseTo(6.8, 5);
    expect(groupClipDurationForInput(input(5))).toBeCloseTo(11, 5);
  });

  it("cycles the camera move so neighbouring photos differ", () => {
    expect([0, 1, 2, 3, 4].map(motionForIndex)).toEqual([
      "push-in",
      "pan-right",
      "pull-out",
      "pan-left",
      "push-in",
    ]);
  });
});

describe("buildVideoSegmentFilter", () => {
  it("fills the output frame and drops the source aspect ratio", () => {
    expect(buildVideoSegmentFilter(1280, 720, 30)).toBe(
      "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30,format=yuv420p",
    );
  });
});

describe("composeVideoSegmentClip", () => {
  const ffmpeg = ffmpegPath;
  const ffprobe = ffprobePath;
  const canRun = ffmpeg !== null && ffprobe !== null;

  it.runIf(canRun)(
    "cuts the requested range into a playable mp4",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "travel-segment-"));
      temporaryRoots.push(root);
      const transcoder = new FfmpegService(ffmpeg!);
      const probe = new FfprobeService(ffprobe!);

      // 6초짜리 원본을 만들고 2.0~5.0 구간만 잘라 낸다.
      const source = path.join(root, "source.mp4");
      await transcoder.run([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=30:duration=6",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        source,
      ]);

      const storage = new LocalFsAdapter(root);
      const result = await composeVideoSegmentClip(
        {endSec: 5, fps: 30, height: 360, sourcePath: source, startSec: 2, width: 640},
        "out/segment.mp4",
        storage,
        transcoder,
        probe,
      );

      expect(result.durationSec).toBeCloseTo(3, 1);
      const probed = await probe.probe(await storage.localPath("out/segment.mp4"));
      const video = probed.streams?.find((stream) => stream.codec_type === "video");
      expect(video?.width).toBe(640);
      expect(video?.height).toBe(360);
      expect(Number(probed.format?.duration ?? 0)).toBeCloseTo(3, 1);
    },
    120_000,
  );

  it.runIf(canRun)("rejects a range that ends before it starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-segment-bad-"));
    temporaryRoots.push(root);
    await expect(
      composeVideoSegmentClip(
        {endSec: 1, fps: 30, height: 360, sourcePath: "missing.mp4", startSec: 4, width: 640},
        "out/segment.mp4",
        new LocalFsAdapter(root),
        new FfmpegService(ffmpeg ?? "ffmpeg"),
        new FfprobeService(ffprobe ?? "ffprobe"),
      ),
    ).rejects.toThrow("끝은 시작보다 뒤여야");
  });
});
