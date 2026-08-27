import {spawn} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  renderPlanSchema,
  verifyReportSchema,
  type RenderPlan,
  type VerifyCheck,
  type VerifyReport,
} from "@travel-movie/schema";

import type {StorageAdapter} from "../storage/storage-adapter.js";
import type {MediaTranscoder} from "./ffmpeg.js";
import type {MediaProbe} from "./ffprobe.js";

export interface RenderVerificationDependencies {
  readonly ffmpegPath: string;
  readonly probe: MediaProbe;
  readonly storage: StorageAdapter;
  readonly transcoder: MediaTranscoder;
}

export interface RenderVerificationOptions {
  readonly captionFrameKey?: string;
  readonly projectId: string;
  readonly reportKey?: string;
}

const readNumber = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const frameRate = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }
  const [numerator, denominator = 1] = value.split("/").map(Number);
  const parsed = numerator! / denominator;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const runCapture = async (binary: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(
          `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`,
        );
      } else {
        reject(
          new Error(
            `FFmpeg verification exited with ${String(code)}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      }
    });
  });

const metadataChecks = async (
  outputPath: string,
  plan: RenderPlan,
  probe: MediaProbe,
): Promise<VerifyCheck[]> => {
  const metadata = await probe.probe(outputPath);
  const video = metadata.streams?.find((stream) => stream.codec_type === "video");
  const audio = metadata.streams?.find((stream) => stream.codec_type === "audio");
  const durationSec = readNumber(metadata.format?.duration);
  const expectedDurationSec = plan.totalFrames / plan.fps;
  const fps = frameRate(video?.avg_frame_rate ?? video?.r_frame_rate);
  const durationPass = durationSec !== null && Math.abs(durationSec - expectedDurationSec) <= 0.1;
  const videoPass =
    video?.codec_name === "h264" &&
    video.width === plan.width &&
    video.height === plan.height &&
    fps !== null &&
    Math.abs(fps - plan.fps) < 0.001;
  return [
    {
      message: durationPass ? "Duration matches the render plan" : "Duration differs from plan",
      metrics: {actualSec: durationSec, expectedSec: expectedDurationSec, toleranceSec: 0.1},
      name: "duration",
      status: durationPass ? "pass" : "fail",
    },
    {
      message: videoPass ? "Video stream metadata is correct" : "Video stream metadata is wrong",
      metrics: {
        codec: video?.codec_name ?? null,
        fps,
        height: video?.height ?? null,
        width: video?.width ?? null,
      },
      name: "video-stream",
      status: videoPass ? "pass" : "fail",
    },
    {
      message: audio === undefined ? "Output has no audio stream" : "Unexpected audio stream found",
      metrics: {hasAudio: audio !== undefined},
      name: "silent-output",
      status: audio === undefined ? "pass" : "fail",
    },
  ];
};

const blackCheck = async (
  outputPath: string,
  durationSec: number,
  ffmpegPath: string,
): Promise<VerifyCheck> => {
  const output = await runCapture(ffmpegPath, [
    "-hide_banner",
    "-i",
    outputPath,
    "-vf",
    "blackdetect=d=0.5:pix_th=0.10",
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const durations = [...output.matchAll(/black_duration:([0-9.]+)/gu)].map((match) =>
    Number(match[1]),
  );
  const blackDurationSec = durations.reduce((sum, value) => sum + value, 0);
  const ratio = durationSec <= 0 ? 1 : blackDurationSec / durationSec;
  return {
    message: ratio < 0.05 ? "Black frames stay below 5%" : "Too much black video detected",
    metrics: {blackDurationSec, blackRatio: ratio, threshold: 0.05},
    name: "blackdetect",
    status: ratio < 0.05 ? "pass" : "fail",
  };
};

const sampleFrameCheck = async (
  outputPath: string,
  durationSec: number,
  temporaryRoot: string,
  transcoder: MediaTranscoder,
): Promise<VerifyCheck> => {
  const stdevs: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const timeSec = ((index + 1) / 11) * durationSec;
    const framePath = path.join(temporaryRoot, `sample-${String(index)}.png`);
    await transcoder.run([
      "-y",
      "-ss",
      timeSec.toFixed(3),
      "-i",
      outputPath,
      "-frames:v",
      "1",
      "-an",
      framePath,
    ]);
    const stats = await sharp(await readFile(framePath)).stats();
    const channels = stats.channels.slice(0, 3);
    stdevs.push(channels.reduce((sum, channel) => sum + channel.stdev, 0) / channels.length);
  }
  const flatFrames = stdevs.filter((value) => value < 3).length;
  return {
    message:
      flatFrames < 3 ? "Sampled frames contain visual detail" : "Three or more flat frames found",
    metrics: {
      flatFrames,
      maxStdev: Math.max(...stdevs),
      minStdev: Math.min(...stdevs),
      samples: stdevs.length,
    },
    name: "sample-frame-variance",
    status: flatFrames < 3 ? "pass" : "fail",
  };
};

const captionFrameCheck = async (
  outputPath: string,
  plan: RenderPlan,
  temporaryRoot: string,
  key: string,
  dependencies: RenderVerificationDependencies,
): Promise<VerifyCheck> => {
  const caption = plan.scenes.flatMap((scene) => scene.captions).at(0);
  if (caption === undefined) {
    return {
      message: "No caption exists in the render plan - skipped",
      metrics: {},
      name: "caption-frame",
      status: "skipped",
    };
  }
  const framePath = path.join(temporaryRoot, "caption-frame.png");
  const frame = caption.startFrame + Math.floor(caption.durationInFrames / 2);
  await dependencies.transcoder.run([
    "-y",
    "-ss",
    (frame / plan.fps).toFixed(3),
    "-i",
    outputPath,
    "-frames:v",
    "1",
    "-an",
    framePath,
  ]);
  const image = await readFile(framePath);
  const metadata = await sharp(image).metadata();
  await dependencies.storage.write(key, image);
  return {
    message: "Caption frame was extracted for visual Korean font inspection",
    metrics: {frame, height: metadata.height ?? null, key, width: metadata.width ?? null},
    name: "caption-frame",
    status: "pass",
  };
};

export const verifyRenderedVideo = async (
  outputPath: string,
  inputPlan: RenderPlan,
  options: RenderVerificationOptions,
  dependencies: RenderVerificationDependencies,
): Promise<VerifyReport> => {
  const plan = renderPlanSchema.parse(inputPlan);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "travel-verify-"));
  try {
    const checks = await metadataChecks(outputPath, plan, dependencies.probe);
    checks.push(await blackCheck(outputPath, plan.totalFrames / plan.fps, dependencies.ffmpegPath));
    checks.push(
      await sampleFrameCheck(
        outputPath,
        plan.totalFrames / plan.fps,
        temporaryRoot,
        dependencies.transcoder,
      ),
    );
    checks.push(
      await captionFrameCheck(
        outputPath,
        plan,
        temporaryRoot,
        options.captionFrameKey ?? "verification/caption-frame.png",
        dependencies,
      ),
    );
    const report = verifyReportSchema.parse({
      checks,
      createdAt: new Date().toISOString(),
      outputPath,
      projectId: options.projectId,
      schemaVersion: 2,
      status: checks.some((check) => check.status === "fail") ? "fail" : "pass",
    });
    await dependencies.storage.write(
      options.reportKey ?? "manifests/verify-report.json",
      Buffer.from(JSON.stringify(report, null, 2)),
    );
    return report;
  } finally {
    await rm(temporaryRoot, {force: true, maxRetries: 5, recursive: true, retryDelay: 100});
  }
};
