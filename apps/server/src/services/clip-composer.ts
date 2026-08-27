import {createReadStream} from "node:fs";
import {mkdtemp, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import type {MediaProbe} from "./ffprobe.js";
import type {MediaTranscoder} from "./ffmpeg.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";

export const CLIP_COMPOSER_CODE_VERSION = 1;

/** 사진 한 장에 적용할 카메라 움직임. 그룹 안에서 순환하며 사용한다. */
export type ClipMotion = "push-in" | "pull-out" | "pan-right" | "pan-left";

const MOTION_CYCLE: readonly ClipMotion[] = ["push-in", "pan-right", "pull-out", "pan-left"];

export const motionForIndex = (index: number): ClipMotion =>
  MOTION_CYCLE[index % MOTION_CYCLE.length]!;

export interface ComposeGroupClipInput {
  readonly crossfadeSec: number;
  readonly fps: number;
  readonly height: number;
  readonly perPhotoSec: number;
  /** 사진의 절대 경로. 순서가 곧 등장 순서다. */
  readonly photoPaths: readonly string[];
  readonly width: number;
}

const ZOOM_RANGE = 0.16;

/**
 * zoompan 은 입력 프레임 하나당 d 개의 출력 프레임을 만든다.
 * 정지 이미지를 그대로 넣고 d 를 프레임 수로 지정해야 길이가 정확히 맞는다.
 */
const motionFilter = (motion: ClipMotion, frames: number): string => {
  const last = Math.max(1, frames - 1);
  const ramp = `on/${String(last)}`;
  if (motion === "push-in") {
    return `zoompan=z='1+${String(ZOOM_RANGE)}*${ramp}':d=${String(frames)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  }
  if (motion === "pull-out") {
    return `zoompan=z='${String(1 + ZOOM_RANGE)}-${String(ZOOM_RANGE)}*${ramp}':d=${String(frames)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  }
  const zoom = 1 + ZOOM_RANGE * 0.75;
  const travel = motion === "pan-right" ? ramp : `(1-${ramp})`;
  return `zoompan=z='${zoom.toFixed(3)}':d=${String(frames)}:x='(iw-iw/zoom)*${travel}':y='ih/2-(ih/zoom/2)'`;
};

export const buildGroupClipFilter = (input: ComposeGroupClipInput): string => {
  const count = input.photoPaths.length;
  if (count === 0) {
    throw new Error("클립을 만들려면 사진이 최소 한 장 필요합니다.");
  }
  const frames = Math.max(2, Math.round(input.perPhotoSec * input.fps));
  // zoompan 은 확대할 때 원본 해상도가 낮으면 계단 현상이 생긴다. 두 배로 올린 뒤 잘라 쓴다.
  const sourceWidth = input.width * 2;
  const sourceHeight = input.height * 2;
  const stages = input.photoPaths.map((_, index) => {
    const motion = motionForIndex(index);
    return [
      `[${String(index)}:v]scale=${String(sourceWidth)}:${String(sourceHeight)}:force_original_aspect_ratio=increase`,
      `crop=${String(sourceWidth)}:${String(sourceHeight)}`,
      `${motionFilter(motion, frames)}:s=${String(input.width)}x${String(input.height)}:fps=${String(input.fps)}`,
      "setsar=1",
      `format=yuv420p[v${String(index)}]`,
    ].join(",");
  });
  if (count === 1) {
    return `${stages[0]!};[v0]null[out]`;
  }
  const clipSec = frames / input.fps;
  const transitions: string[] = [];
  let accumulated = clipSec;
  let previous = "v0";
  for (let index = 1; index < count; index += 1) {
    const label = index === count - 1 ? "out" : `x${String(index)}`;
    const offset = accumulated - input.crossfadeSec;
    transitions.push(
      `[${previous}][v${String(index)}]xfade=transition=fade:duration=${input.crossfadeSec.toFixed(3)}:offset=${offset.toFixed(3)}[${label}]`,
    );
    accumulated = accumulated + clipSec - input.crossfadeSec;
    previous = label;
  }
  return [...stages, ...transitions].join(";");
};

export const groupClipDurationForInput = (input: ComposeGroupClipInput): number => {
  const frames = Math.max(2, Math.round(input.perPhotoSec * input.fps));
  const clipSec = frames / input.fps;
  return clipSec * input.photoPaths.length - input.crossfadeSec * (input.photoPaths.length - 1);
};

/**
 * 사진 그룹을 실제 mp4 클립으로 만든다. ComfyUI 같은 외부 생성기가 없어도
 * 파이프라인이 끝까지 돌도록 하는 기본 경로다.
 */
export const composeGroupClip = async (
  input: ComposeGroupClipInput,
  outputKey: string,
  storage: StorageAdapter,
  transcoder: MediaTranscoder,
  probe: MediaProbe,
  signal?: AbortSignal,
): Promise<{durationSec: number; outputKey: string}> => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "autoveo-clip-"));
  try {
    const temporaryOutput = path.join(temporaryRoot, "clip.mp4");
    const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
    for (const photoPath of input.photoPaths) {
      args.push("-i", photoPath);
    }
    args.push(
      "-filter_complex",
      buildGroupClipFilter(input),
      "-map",
      "[out]",
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "20",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(input.fps),
      "-movflags",
      "+faststart",
      temporaryOutput,
    );
    await transcoder.run(args, {signal});

    const info = await stat(temporaryOutput);
    if (info.size <= 0) {
      throw new Error("생성한 클립 파일이 비어 있습니다.");
    }
    const probed = await probe.probe(temporaryOutput);
    const durationSec = Number(probed.format?.duration ?? 0);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error("생성한 클립의 길이를 확인할 수 없습니다.");
    }
    const videoStream = probed.streams?.find((stream) => stream.codec_type === "video");
    if (videoStream === undefined) {
      throw new Error("생성한 클립에 영상 스트림이 없습니다.");
    }
    await storage.write(outputKey, createReadStream(temporaryOutput));
    return {durationSec: Math.round(durationSec * 1000) / 1000, outputKey};
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true});
  }
};

export interface ComposeVideoSegmentInput {
  readonly endSec: number;
  readonly fps: number;
  readonly height: number;
  /** 잘라 낼 원본 영상의 절대 경로. 원본은 읽기만 한다. */
  readonly sourcePath: string;
  readonly startSec: number;
  readonly width: number;
}

/** 잘라 낸 구간을 출력 규격에 맞춰 채운다. 비율이 다르면 잘라서 꽉 채운다. */
export const buildVideoSegmentFilter = (width: number, height: number, fps: number): string =>
  [
    `scale=${String(width)}:${String(height)}:force_original_aspect_ratio=increase`,
    `crop=${String(width)}:${String(height)}`,
    "setsar=1",
    `fps=${String(fps)}`,
    "format=yuv420p",
  ].join(",");

/**
 * 촬영 영상에서 고른 구간을 독립된 mp4 클립으로 만든다.
 * 그룹 클립과 같은 규격으로 나오므로 타임라인에서 똑같이 다룰 수 있다.
 */
export const composeVideoSegmentClip = async (
  input: ComposeVideoSegmentInput,
  outputKey: string,
  storage: StorageAdapter,
  transcoder: MediaTranscoder,
  probe: MediaProbe,
  signal?: AbortSignal,
): Promise<{durationSec: number; outputKey: string}> => {
  const durationSec = input.endSec - input.startSec;
  if (durationSec <= 0) {
    throw new Error("구간의 끝은 시작보다 뒤여야 합니다.");
  }
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "autoveo-segment-"));
  try {
    const temporaryOutput = path.join(temporaryRoot, "segment.mp4");
    await transcoder.run(
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        // -ss 를 -i 앞에 두면 빠르게 찾고, -i 뒤 -t 로 정확히 자른다.
        "-ss",
        input.startSec.toFixed(3),
        "-i",
        input.sourcePath,
        "-t",
        durationSec.toFixed(3),
        "-vf",
        buildVideoSegmentFilter(input.width, input.height, input.fps),
        "-an",
        "-c:v",
        "libx264",
        "-crf",
        "20",
        "-preset",
        "medium",
        "-pix_fmt",
        "yuv420p",
        "-r",
        String(input.fps),
        "-movflags",
        "+faststart",
        temporaryOutput,
      ],
      {signal},
    );

    const info = await stat(temporaryOutput);
    if (info.size <= 0) {
      throw new Error("잘라 낸 클립 파일이 비어 있습니다.");
    }
    const probed = await probe.probe(temporaryOutput);
    const measured = Number(probed.format?.duration ?? 0);
    if (!Number.isFinite(measured) || measured <= 0) {
      throw new Error("잘라 낸 클립의 길이를 확인할 수 없습니다.");
    }
    if (probed.streams?.some((stream) => stream.codec_type === "video") !== true) {
      throw new Error("잘라 낸 클립에 영상 스트림이 없습니다.");
    }
    await storage.write(outputKey, createReadStream(temporaryOutput));
    return {durationSec: Math.round(measured * 1000) / 1000, outputKey};
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true});
  }
};

/** 클립 목록 화면에 쓸 대표 프레임. 실패해도 파이프라인을 멈추지 않는다. */
export const composeClipThumbnail = async (
  clipPath: string,
  atSec: number,
  thumbKey: string,
  storage: StorageAdapter,
  transcoder: MediaTranscoder,
  signal?: AbortSignal,
): Promise<string> => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "autoveo-thumb-"));
  try {
    const temporaryOutput = path.join(temporaryRoot, "thumb.webp");
    await transcoder.run(
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        Math.max(0, atSec).toFixed(3),
        "-i",
        clipPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=w=520:h=-2:flags=lanczos",
        "-q:v",
        "78",
        temporaryOutput,
      ],
      {signal},
    );
    await storage.write(thumbKey, createReadStream(temporaryOutput));
    return thumbKey;
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true});
  }
};
