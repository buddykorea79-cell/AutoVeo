import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import sharp from "sharp";

import type {MediaTranscoder} from "./ffmpeg.js";

export interface CandidateSegment {
  readonly end: number;
  readonly start: number;
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export const generateCandidateSegments = (
  durationSec: number,
  _motionHints?: readonly number[],
): CandidateSegment[] => {
  void _motionHints;
  if (durationSec < 2) {
    return [{start: 0, end: durationSec}];
  }
  // Heuristic sliding windows + center-biased windows to capture continuous drone shots
  // We use multiple window lengths to capture varied moments
  const lengths = [8, 12, 15, 20];
  const step = 4; // seconds between window starts
  const candidates: CandidateSegment[] = [];

  for (const len of lengths) {
    if (len > durationSec) {
      continue;
    }
    for (let start = 0; start + len <= durationSec + 0.001; start += step) {
      const end = Math.min(start + len, durationSec);
      if (end - start >= 5) {
        candidates.push({start: round1(start), end: round1(end)});
      }
    }
  }

  // Also add larger windows for short videos
  if (durationSec <= 30 && durationSec >= 10) {
    candidates.push({start: 0, end: round1(durationSec)});
  }

  // Deduplicate and add jittered windows around estimated interesting points
  // Estimate interesting by center (drone reveal often mid-flight) -> bias
  const deduped = dedupeSegments(candidates);
  // Limit to ~ 12 candidates max to avoid AI explosion
  if (deduped.length > 14) {
    // Keep windows that are spread across timeline via sampling
    return sampleSpread(deduped, 14);
  }
  return deduped;
};

const round1 = (v: number): number => Math.round(v * 10) / 10;

const dedupeSegments = (segments: readonly CandidateSegment[]): CandidateSegment[] => {
  const key = (s: CandidateSegment): string => `${s.start.toFixed(1)}-${s.end.toFixed(1)}`;
  const seen = new Set<string>();
  const out: CandidateSegment[] = [];
  for (const s of segments) {
    const k = key(s);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
};

const sampleSpread = (segments: readonly CandidateSegment[], max: number): CandidateSegment[] => {
  if (segments.length <= max) {
    return [...segments];
  }
  const step = segments.length / max;
  const out: CandidateSegment[] = [];
  for (let i = 0; i < max; i += 1) {
    const idx = Math.floor(i * step);
    out.push(segments[idx]!);
  }
  return out;
};

// Motion hint extraction: sample frames at 1fps, compute diff, return per-second motion array
export const extractMotionHints = async (
  absolutePath: string,
  durationSec: number,
  transcoder: MediaTranscoder,
  signal?: AbortSignal,
): Promise<number[]> => {
  if (durationSec <= 0) {
    return [];
  }
  const sampleFps = 1; // 1 fps is cheap
  const sampleCount = Math.min(30, Math.max(4, Math.floor(durationSec * sampleFps)));
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "veo-motion-"));
  try {
    const buffers: Buffer[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const t = (durationSec * (i + 0.5)) / sampleCount;
      const outPath = path.join(tmpRoot, `m-${String(i)}.jpg`);
      try {
        await transcoder.run(
          [
            "-y",
            "-ss",
            clamp(t, 0, durationSec - 0.05).toFixed(3),
            "-i",
            absolutePath,
            "-frames:v",
            "1",
            "-q:v",
            "5",
            outPath,
          ],
          {signal},
        );
        const buf = await sharp(outPath).greyscale().resize(64, 64, {fit: "fill"}).raw().toBuffer();
        buffers.push(Buffer.from(buf));
      } catch {
        // ignore frame failures
      }
    }
    const motions: number[] = [];
    for (let i = 1; i < buffers.length; i += 1) {
      const a = buffers[i - 1]!;
      const b = buffers[i]!;
      let diff = 0;
      for (let j = 0; j < a.length; j += 1) {
        diff += Math.abs((a[j] ?? 0) - (b[j] ?? 0));
      }
      motions.push(diff / a.length / 255);
    }
    return motions;
  } finally {
    await rm(tmpRoot, {force: true, recursive: true});
  }
};

// Scene-aware candidate refinement: if motion hints show high change points, split around them
export const refineCandidatesWithMotion = (
  candidates: readonly CandidateSegment[],
  motionHints: readonly number[],
  durationSec: number,
): CandidateSegment[] => {
  if (motionHints.length === 0 || durationSec <= 0) {
    return [...candidates];
  }
  const threshold = 0.08; // tuned
  const spikes: number[] = [];
  for (let i = 0; i < motionHints.length; i += 1) {
    if ((motionHints[i] ?? 0) > threshold) {
      const t = (durationSec * (i + 1)) / (motionHints.length + 1);
      spikes.push(t);
    }
  }
  if (spikes.length === 0) {
    return [...candidates];
  }
  // Add windows centered on spikes
  const extra: CandidateSegment[] = [];
  for (const spike of spikes.slice(0, 4)) {
    const start = clamp(spike - 6, 0, durationSec - 5);
    const end = clamp(start + 10, 5, durationSec);
    if (end - start >= 5) {
      extra.push({start: round1(start), end: round1(end)});
    }
  }
  return dedupeSegments([...candidates, ...extra]);
};
