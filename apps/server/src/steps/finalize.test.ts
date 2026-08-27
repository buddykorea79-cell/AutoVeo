import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {ffmpegPath, ffprobePath} from "ffmpeg-ffprobe-static";
import {afterEach, describe, expect, it} from "vitest";

import {renderPlanSchema, type AudioTrack, type RenderPlan} from "@travel-movie/schema";

import {FfmpegService} from "../services/ffmpeg.js";
import {FfprobeService} from "../services/ffprobe.js";
import {LocalFsAdapter} from "../storage/local-fs-adapter.js";
import {buildBgmFilterGraph, FinalVideoFinalizer} from "./finalize.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, {force: true, maxRetries: 5, recursive: true, retryDelay: 100}),
      ),
  );
});

const planFor = (durationInFrames: number, audio: readonly AudioTrack[]): RenderPlan =>
  renderPlanSchema.parse({
    audio,
    fps: 30,
    height: 180,
    scenes: [
      {
        assetKey: null,
        assetUrl: "color://test",
        captions: [],
        durationInFrames,
        id: "scene-1",
        mediaId: null,
        motion: null,
        sourceAudio: "mute",
        startFrame: 0,
        transitionIn: {overlapFrames: 0, type: "cut"},
        trimStartFrame: null,
        type: "color",
        visibleFrames: durationInFrames,
      },
    ],
    schemaVersion: 2,
    totalFrames: durationInFrames,
    width: 320,
  });

describe("FFmpeg finalizer", () => {
  it("builds frame-derived atrim, delay, fades, crossfade, and duck filters", () => {
    const tracks: AudioTrack[] = [
      {
        duckRanges: [{durationInFrames: 15, gainDb: -8, startFrame: 15}],
        durationInFrames: 60,
        fadeInFrames: 30,
        fadeOutFrames: 30,
        sourceOffsetSec: 0,
        sourcePath: "first.wav",
        startFrame: 0,
        trackId: "first",
        volumeDb: -6,
      },
      {
        duckRanges: [],
        durationInFrames: 60,
        fadeInFrames: 30,
        fadeOutFrames: 30,
        sourceOffsetSec: 1,
        sourcePath: "second.wav",
        startFrame: 60,
        trackId: "second",
        volumeDb: -5,
      },
    ];
    const graph = buildBgmFilterGraph(tracks, 30);
    expect(graph.filterGraph).toContain("atrim=start=0.000000");
    expect(graph.filterGraph).toContain("adelay=delays=0:all=1");
    expect(graph.filterGraph).toContain("afade=t=in");
    expect(graph.filterGraph).toContain("acrossfade=d=1.000000");
    expect(graph.filterGraph).toContain("between(t\\,0.500000\\,1.000000)");
  });

  it("copies H.264 video, normalizes audio in two passes, and writes a passing report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-finalize-test-"));
    temporaryDirectories.push(root);
    const storage = new LocalFsAdapter(path.join(root, "work"));
    const transcoder = new FfmpegService(ffmpegPath!);
    const probe = new FfprobeService(ffprobePath!);
    const intermediatePath = path.join(root, "intermediate.mp4");
    const audioPath = path.join(root, "music.wav");
    await transcoder.run([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=3",
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      intermediatePath,
    ]);
    await transcoder.run([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=3",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ]);
    const plan = planFor(90, [
      {
        duckRanges: [{durationInFrames: 15, gainDb: -4, startFrame: 30}],
        durationInFrames: 90,
        fadeInFrames: 15,
        fadeOutFrames: 15,
        sourceOffsetSec: 0,
        sourcePath: audioPath,
        startFrame: 0,
        trackId: "tone",
        volumeDb: -6,
      },
    ]);
    const finalizer = new FinalVideoFinalizer({
      ffmpegPath: ffmpegPath!,
      outputRoot: path.join(root, "output"),
      probe,
      storage,
      transcoder,
    });
    const result = await finalizer.finalize(plan, intermediatePath, {
      projectId: "with-audio",
      title: "통합 검증",
    });
    expect(result.status).toBe("pass");
    expect(result.hasAudio).toBe(true);
    const metadata = await probe.probe(result.outputPath);
    expect(metadata.streams?.find((stream) => stream.codec_type === "video")?.codec_name).toBe(
      "h264",
    );
    expect(metadata.streams?.find((stream) => stream.codec_type === "audio")).toMatchObject({
      codec_name: "aac",
      sample_rate: "48000",
    });
    const report = JSON.parse((await storage.read(result.reportKey)).toString("utf8")) as {
      checks: Array<{name: string; status: string}>;
      status: string;
    };
    expect(report.status).toBe("pass");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({name: "video-copy", status: "pass"}),
        expect.objectContaining({name: "loudnorm", status: "pass"}),
        expect.objectContaining({name: "brightness-samples", status: "pass"}),
      ]),
    );
  }, 60_000);

  it("uses -an semantics when music is absent and every scene is muted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "travel-finalize-silent-"));
    temporaryDirectories.push(root);
    const storage = new LocalFsAdapter(path.join(root, "work"));
    const transcoder = new FfmpegService(ffmpegPath!);
    const probe = new FfprobeService(ffprobePath!);
    const intermediatePath = path.join(root, "intermediate.mp4");
    await transcoder.run([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=2",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      intermediatePath,
    ]);
    const finalizer = new FinalVideoFinalizer({
      ffmpegPath: ffmpegPath!,
      outputRoot: path.join(root, "output"),
      probe,
      storage,
      transcoder,
    });
    const result = await finalizer.finalize(planFor(60, []), intermediatePath, {
      projectId: "silent",
      title: "무음 검증",
    });
    const metadata = await probe.probe(result.outputPath);
    expect(metadata.streams?.some((stream) => stream.codec_type === "audio")).toBe(false);
    const report = JSON.parse((await storage.read(result.reportKey)).toString("utf8")) as {
      checks: Array<{name: string; status: string}>;
      status: string;
    };
    expect(report.status).toBe("pass");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({name: "silencedetect", status: "skipped"}),
        expect.objectContaining({name: "loudnorm", status: "skipped"}),
      ]),
    );
  }, 60_000);
});
