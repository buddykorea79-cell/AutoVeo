import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import sharp from "sharp";

import type {MediaTranscoder} from "./ffmpeg.js";

export interface QualityScores {
  readonly brightness: number;
  readonly motion: number;
  readonly sharpness: number;
  readonly stability: number;
}

export interface FrameQuality {
  readonly brightness: number;
  readonly sharpness: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const calculateFrameSharpness = async (input: Buffer): Promise<number> => {
  // Laplacian variance via sharp convolve -> stats stdev
  const gray = sharp(input).greyscale().resize(256, 256, {fit: "inside", withoutEnlargement: true});
  const stats = await gray
    .clone()
    .convolve({width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0]})
    .stats();
  const stdev = stats.channels[0]?.stdev ?? 0;
  if (!Number.isFinite(stdev)) {
    return 0;
  }
  // stdev 0..~80 -> normalize 0..1 (empirical)
  const variance = stdev * stdev;
  // map variance to 0..1 via log-ish
  const normalized = clamp(Math.log10(variance + 1) / 3, 0, 1);
  return normalized;
};

export const calculateFrameBrightness = async (input: Buffer): Promise<number> => {
  const {data} = await sharp(input).greyscale().raw().toBuffer({resolveWithObject: true});
  let sum = 0;
  for (const v of data) {
    sum += v;
  }
  const avg = sum / data.length / 255;
  // Penalize too dark (<0.15) or too bright (>0.9)
  if (avg < 0.15) {
    return clamp(avg / 0.15, 0, 1) * 0.7;
  }
  if (avg > 0.9) {
    return clamp((1 - avg) / 0.1, 0, 1) * 0.7;
  }
  // Ideal around 0.4-0.7 -> 1.0, tapering
  if (avg >= 0.35 && avg <= 0.75) {
    return 0.9 + 0.1 * (1 - Math.abs(avg - 0.55) / 0.2);
  }
  return clamp(0.5 + 0.5 * (1 - Math.abs(avg - 0.5)), 0, 1);
};

export const estimateMotionBetweenFrames = async (prev: Buffer, curr: Buffer): Promise<number> => {
  const a = await sharp(prev).greyscale().resize(64, 64, {fit: "fill"}).raw().toBuffer();
  const b = await sharp(curr).greyscale().resize(64, 64, {fit: "fill"}).raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  const avgDiff = diff / a.length / 255;
  // avgDiff 0..1, typical motion 0.02..0.2 . Normalize
  return clamp(avgDiff * 5, 0, 1);
};

export const analyzeCandidateQuality = async (
  frames: readonly Buffer[],
): Promise<QualityScores> => {
  if (frames.length === 0) {
    return {brightness: 0.5, motion: 0.5, sharpness: 0.5, stability: 0.5};
  }
  const sharpnessValues: number[] = [];
  const brightnessValues: number[] = [];
  for (const frame of frames) {
    sharpnessValues.push(await calculateFrameSharpness(frame));
    brightnessValues.push(await calculateFrameBrightness(frame));
  }
  const avgSharpness = sharpnessValues.reduce((a, b) => a + b, 0) / sharpnessValues.length;
  const avgBrightness = brightnessValues.reduce((a, b) => a + b, 0) / brightnessValues.length;

  let motionSum = 0;
  let motionCount = 0;
  for (let i = 1; i < frames.length; i += 1) {
    motionSum += await estimateMotionBetweenFrames(frames[i - 1]!, frames[i]!);
    motionCount += 1;
  }
  const avgMotion = motionCount === 0 ? 0.5 : motionSum / motionCount;
  // stability: penalize high variance in motion (jitter) but allow intentional motion
  // compute motion variance
  let motionVariance = 0;
  if (motionCount > 1) {
    const motions: number[] = [];
    for (let i = 1; i < frames.length; i += 1) {
      motions.push(await estimateMotionBetweenFrames(frames[i - 1]!, frames[i]!));
    }
    const mean = motions.reduce((a, b) => a + b, 0) / motions.length;
    const variance = motions.reduce((a, b) => a + (b - mean) ** 2, 0) / motions.length;
    motionVariance = variance;
  }
  // motion 0..1, stability ~1 - variance*10 but not penalizing smooth motion
  const stability = clamp(1 - motionVariance * 20, 0, 1) * 0.7 + 0.3;
  // Motion score: moderate motion is good (0.2-0.6 ideal), too static or too shaky lower
  let motionScore: number;
  if (avgMotion < 0.05) {
    motionScore = clamp(avgMotion / 0.05, 0, 1) * 0.6;
  } else if (avgMotion > 0.7) {
    motionScore = clamp((1 - avgMotion) / 0.3, 0, 1) * 0.6;
  } else {
    motionScore = 0.6 + 0.4 * (1 - Math.abs(avgMotion - 0.35) / 0.35);
  }

  return {
    brightness: clamp(avgBrightness, 0, 1),
    motion: clamp(motionScore, 0, 1),
    sharpness: clamp(avgSharpness, 0, 1),
    stability: clamp(stability, 0, 1),
  };
};

export const extractFramesForQuality = async (
  absolutePath: string,
  start: number,
  end: number,
  transcoder: MediaTranscoder,
  signal?: AbortSignal,
): Promise<Buffer[]> => {
  const duration = end - start;
  if (duration <= 0) {
    return [];
  }
  const sampleCount = Math.min(5, Math.max(2, Math.floor(duration / 2) + 1));
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "veo-quality-"));
  try {
    const frames: Buffer[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const t = start + (duration * (i + 0.5)) / sampleCount;
      const outPath = path.join(tmpRoot, `frame-${String(i)}.jpg`);
      await transcoder.run(
        ["-y", "-ss", t.toFixed(3), "-i", absolutePath, "-frames:v", "1", "-q:v", "2", outPath],
        {signal},
      );
      const sharpBuf = await sharp(outPath).jpeg({quality: 80}).toBuffer();
      frames.push(sharpBuf);
    }
    return frames;
  } finally {
    await rm(tmpRoot, {force: true, recursive: true});
  }
};
