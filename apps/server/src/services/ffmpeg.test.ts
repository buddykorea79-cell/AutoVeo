import {mkdtemp, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {ffmpegPath} from "ffmpeg-ffprobe-static";
import {afterEach, describe, expect, it} from "vitest";

import {FfmpegService} from "./ffmpeg.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, {force: true, maxRetries: 5, recursive: true, retryDelay: 100})),
  );
});

const binary = (): string => {
  if (ffmpegPath === null) {
    throw new Error("Bundled ffmpeg is unavailable");
  }
  return ffmpegPath;
};

describe("FfmpegService", () => {
  it("parses -progress out_time_ms into monotonic fractions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-ffmpeg-progress-"));
    temporaryRoots.push(root);
    const output = path.join(root, "progress.mp4");
    const progress: number[] = [];
    await new FfmpegService(binary()).run(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=64x48:r=10:d=1",
        "-an",
        "-c:v",
        "libx264",
        output,
      ],
      {durationSec: 1, onProgress: (value) => progress.push(value)},
    );

    expect((await stat(output)).size).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
  });

  it("kills an active child process when its AbortSignal fires", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-ffmpeg-cancel-"));
    temporaryRoots.push(root);
    const controller = new AbortController();
    const running = new FfmpegService(binary()).run(
      [
        "-y",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x48:r=10:d=30",
        "-an",
        "-c:v",
        "libx264",
        path.join(root, "cancelled.mp4"),
      ],
      {signal: controller.signal},
    );
    setTimeout(() => controller.abort(new Error("test cancellation")), 100);
    await expect(running).rejects.toThrow("test cancellation");
  });
});
